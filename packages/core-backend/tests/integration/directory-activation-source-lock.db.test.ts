import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { activatePendingUser } from '../../src/auth/user-activate'

// Two-point wiring self-check (feedback: an unwired *.db.test.ts skip-greens forever). This
// suite must be BOTH excluded from the no-DB job (so it cannot skip-green there) AND listed in
// the approval real-DB run list (so it actually executes). If either point is dropped, this
// runs — and reds — in the real-DB job.
describe('directory-activation-source-lock wiring', () => {
  const filename = 'tests/integration/directory-activation-source-lock.db.test.ts'
  const repoRoot = path.resolve(__dirname, '../../../..')
  it('is excluded from the no-DB job and wired into the approval real-DB step', () => {
    const vitestConfig = readFileSync(
      path.join(repoRoot, 'packages/core-backend/vitest.config.ts'),
      'utf8',
    )
    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
    expect(vitestConfig).toContain(filename)
    expect(workflow).toContain(filename)
  })
})

/**
 * Post-merge review P1 (2026-08-10): T3 activation locks `users` but read the directory source
 * (account/link/integration) UNLOCKED. Under READ COMMITTED an admin could deactivate the
 * integration on another connection and COMMIT between the source read and the activation's own
 * commit — activating a user against a now-inactive source, violating "admin 激活不得对 inactive
 * 目录源静默开通". The fix adds `FOR SHARE OF ... di` to the source read.
 *
 * This is a CONSTRUCTED race, not a sequential argument: a second connection holds an
 * uncommitted integration deactivation, and we prove — via pg_locks — that the real
 * activatePendingUser BLOCKS on that transaction (its FOR SHARE cannot proceed). When the
 * deactivation then commits, the FOR SHARE's READ COMMITTED EPQ recheck refetches the fresh
 * 'inactive' status and the activation refuses ACTIVATE_INTEGRATION_INACTIVE, writing nothing.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const PREFIX = `t3-src-lock-${TS}`

type Seeded = {
  userId: string
  orgId: string
  integrationId: string
  accountId: string
}

async function cleanup(): Promise<void> {
  await query(`DELETE FROM user_login_aliases WHERE user_id LIKE $1`, [`${PREFIX}%`])
  await query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`${PREFIX}%`])
  await query(`DELETE FROM directory_account_links WHERE local_user_id LIKE $1`, [`${PREFIX}%`])
  await query(
    `DELETE FROM directory_accounts WHERE integration_id IN
       (SELECT id FROM directory_integrations WHERE org_id LIKE $1)`,
    [`${PREFIX}%`],
  )
  await query(`DELETE FROM directory_integrations WHERE org_id LIKE $1`, [`${PREFIX}%`])
  await query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}%`])
}

async function seed(): Promise<Seeded> {
  const orgId = `${PREFIX}-org-${randomUUID()}`
  const userId = `${PREFIX}-user-${randomUUID()}`
  const integration = await query<{ id: string }>(
    `INSERT INTO directory_integrations (name, corp_id, org_id, provider, status, default_deprovision_policy)
     VALUES ($1, $2, $3, 'dingtalk', 'active', 'manual_review')
     RETURNING id::text AS id`,
    [`${PREFIX}-integration`, `${PREFIX}-corp-${randomUUID()}`, orgId],
  )
  const integrationId = integration.rows[0].id
  await query(
    `INSERT INTO users (id, email, password_hash, is_active, activation_status, local_password_set)
     VALUES ($1, $2, 'x', FALSE, 'pending_activation', FALSE)`,
    [userId, `${userId}@example.com`],
  )
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active)
     VALUES ($1::uuid, 'dingtalk', $2, $3, 'Source', TRUE)
     RETURNING id::text AS id`,
    [integrationId, `${PREFIX}-ext-${randomUUID()}`, `dingtalk:${PREFIX}:${randomUUID()}`],
  )
  const accountId = account.rows[0].id
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
     VALUES ($1::uuid, $2, 'linked')`,
    [accountId, userId],
  )
  return { userId, orgId, integrationId, accountId }
}

describeIfDatabase('T3 activation source read serialises against integration deactivation (real DB)', () => {
  beforeEach(cleanup)
  afterAll(cleanup)

  // Both branches of the source read must serialise. The IMPLICIT branch (no directoryAccountId,
  // links-by-user) and the EXPLICIT branch (directoryAccountId, the path the production DingTalk
  // OAuth SSO activation at routes/auth.ts takes — resolveDingTalkActivationSource passes an
  // explicit account id) compile to different SQL, so a fix to one is not a fix to the other.
  async function proveRaceRefuses(useExplicitAccount: boolean): Promise<void> {
    const seeded = await seed()

    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let activation: Promise<unknown> | null = null
    try {
      // Connection B: deactivate the integration but DO NOT commit — this holds an exclusive row
      // lock on the integration tuple and assigns B a transaction id.
      await holder.query('BEGIN')
      await holder.query(
        `UPDATE directory_integrations SET status = 'inactive' WHERE id = $1::uuid`,
        [seeded.integrationId],
      )
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
      const holderXid = String(
        (
          await holder.query(
            `SELECT transactionid::text AS xid
               FROM pg_locks
              WHERE pid = $1 AND locktype = 'transactionid' AND granted
              LIMIT 1`,
            [holderPid],
          )
        ).rows[0]?.xid,
      )
      expect(holderXid).not.toBe('undefined')

      // The real activation starts and MUST block: its FOR SHARE read of the integration row
      // cannot proceed while B's uncommitted UPDATE holds the row. (Its own users lock is taken
      // without contention, so any wait it has is on B's deactivation, not the user lock.)
      activation = activatePendingUser({
        userId: seeded.userId,
        mode: 'admin_no_password',
        adminUserId: 'admin-test',
        ...(useExplicitAccount ? { directoryAccountId: seeded.accountId } : {}),
      })
      const settledEarly = { done: false }
      activation.then(
        () => { settledEarly.done = true },
        () => { settledEarly.done = true },
      )

      // Deterministic barrier (no sleep-and-hope): wait until a DIFFERENT backend is provably
      // blocked WAITING ON B's transaction — i.e. on the integration deactivation specifically.
      let blockedPid = 0
      for (let attempt = 0; attempt < 100 && blockedPid === 0; attempt += 1) {
        const waiting = await holder.query(
          `SELECT blocked.pid AS pid
             FROM pg_locks blocked
            WHERE NOT blocked.granted
              AND blocked.locktype = 'transactionid'
              AND blocked.transactionid::text = $1
              AND blocked.pid <> $2
            LIMIT 1`,
          [holderXid, holderPid],
        )
        blockedPid = Number(waiting.rows[0]?.pid ?? 0)
        if (blockedPid === 0) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(blockedPid).toBeGreaterThan(0) // the activation is blocked on the deactivation
      expect(settledEarly.done).toBe(false) // and therefore has NOT resolved

      // Additionally pin that B's lock is on the integration relation (context for the wait).
      const holderRel = await holder.query(
        `SELECT 1
           FROM pg_locks
          WHERE pid = $1 AND relation = 'directory_integrations'::regclass AND granted
          LIMIT 1`,
        [holderPid],
      )
      expect(holderRel.rows.length).toBe(1)

      // The deactivation commits. The activation's FOR SHARE EPQ recheck now sees 'inactive'.
      await holder.query('COMMIT')

      await expect(activation).rejects.toMatchObject({ code: 'ACTIVATE_INTEGRATION_INACTIVE' })
      activation = null
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* already committed */ }
      await holder.end()
      if (activation) { await activation.catch(() => undefined) }
    }

    // Fail-closed: nothing was written — the user is still pending, with no membership.
    const user = await query<{ activation_status: string; is_active: boolean }>(
      `SELECT activation_status, is_active FROM users WHERE id = $1`,
      [seeded.userId],
    )
    expect(user.rows[0]).toEqual({ activation_status: 'pending_activation', is_active: false })
    const membership = await query(`SELECT 1 FROM user_orgs WHERE user_id = $1`, [seeded.userId])
    expect(membership.rows).toHaveLength(0)
  }

  it('IMPLICIT branch (no directoryAccountId): blocks on the deactivation and refuses once it commits', async () => {
    await proveRaceRefuses(false)
  }, 30_000)

  it('EXPLICIT branch (directoryAccountId — the OAuth SSO activation path): blocks and refuses too', async () => {
    await proveRaceRefuses(true)
  }, 30_000)
})
