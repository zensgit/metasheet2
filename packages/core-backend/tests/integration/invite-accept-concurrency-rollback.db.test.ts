/**
 * Invite accept — real Postgres concurrency + rollback goldens (PR #4559 P2).
 *
 * Pins applyInviteAcceptanceWrites (the same path /invite/accept uses):
 *   1) Two real backends + deterministic row-lock barrier:
 *      - capture first waiter PID blocked (lock chain rooted at holder)
 *      - start second apply, capture a *different* waiter PID also chain-rooted at holder
 *        (second may wait behind the first waiter, not only directly on holder)
 *      - release holder → exactly one apply succeeds, one fails INVITE_LEDGER_CONSUME_FAILED
 *      - two distinct plaintext passwords → only the winner's hash is stored
 *   2) Ledger consume then user UPDATE zero-row → whole txn rolls back;
 *      ledger remains status='pending'.
 *
 * Mutation proofs (independently red this file):
 *   - drop `AND status = 'pending'` from markInviteAccepted → both concurrent
 *     applies can RETURNING-succeed → fulfilledCount !== 1 or both passwords match fails
 *   - split ledger consume and user UPDATE into separate transactions → zero-row user
 *     path leaves ledger accepted instead of pending
 *   - remove the FOR UPDATE barrier wait → first waiter wait times out
 *   - start the *second* apply only after holder ROLLBACK → second distinct-waiter wait
 *     times out (no second backend ever queues on the held row lock) — required red
 *
 * DATABASE_URL-gated + excluded from the no-DB default vitest job (cannot skip-green);
 * whole-file wired into the approval real-DB step in plugin-tests.yml.
 */

import * as bcrypt from 'bcryptjs'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  applyInviteAcceptanceWrites,
  INVITE_LEDGER_CONSUME_FAILED,
  INVITE_TARGET_UPDATE_MISMATCH,
  inviteAcceptWriteErrorCode,
} from '../../src/auth/invite-accept-writes'
import { query } from '../../src/db/pg'
import { getBcryptSaltRounds } from '../../src/security/auth-runtime-config'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const USER_ID = `invite_race_user_${TS}`
const EMAIL = `invite-race-${TS}@example.com`
const TOKEN_BASE = `invite-race-token-${TS}`

const WIN_PASSWORD = 'WinnerPass9A'
const LOSE_PASSWORD = 'LoserPass9B'
const INITIAL_PASSWORD = 'InitialPass9Z'

async function withHolder(fn: (holder: Client, holderPid: number) => Promise<void>): Promise<void> {
  const holder = new Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  try {
    const pidRow = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    await fn(holder, pidRow.rows[0].pid)
  } finally {
    try {
      await holder.query('ROLLBACK')
    } catch {
      /* idle */
    }
    await holder.end()
  }
}

/**
 * Wait until a backend is in Lock wait whose blocking chain eventually reaches holderPid.
 * Returns that waiter's backend pid. `excludePids` skips already-observed waiters so a
 * second call can require a *distinct* queued transaction (not re-detect the first).
 *
 * Second waiters may be blocked by the first waiter rather than directly by the holder;
 * we walk pg_blocking_pids transitively until the chain roots at the holder (or cycles).
 */
async function waitForDistinctWaiterChainRootedAtHolder(
  holderPid: number,
  excludePids: number[] = [],
  timeoutMs = 8000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await query<{ pid: number }>(
      `WITH RECURSIVE lock_edges AS (
         SELECT a.pid AS waiter,
                b.blocker
           FROM pg_stat_activity a
           CROSS JOIN LATERAL unnest(pg_blocking_pids(a.pid)) AS b(blocker)
          WHERE a.wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(a.pid)) > 0
       ),
       chains AS (
         SELECT waiter,
                blocker,
                ARRAY[waiter, blocker]::int[] AS path
           FROM lock_edges
         UNION ALL
         SELECT c.waiter,
                e.blocker,
                c.path || e.blocker
           FROM chains c
           JOIN lock_edges e ON e.waiter = c.blocker
          WHERE NOT (e.blocker = ANY (c.path))
       )
       SELECT DISTINCT waiter AS pid
         FROM chains
        WHERE $1 = ANY (path)
          AND NOT (waiter = ANY ($2::int[]))
        ORDER BY pid
        LIMIT 1`,
      [holderPid, excludePids],
    )
    const pid = r.rows[0]?.pid
    if (typeof pid === 'number' && pid > 0) return pid
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error(
    `timed out waiting for a distinct Lock waiter (exclude=${excludePids.join(',') || 'none'}) ` +
      `whose pg_blocking_pids chain roots at holder pid ${holderPid} ` +
      `(second apply never queued while holder held the invite row — e.g. started after ROLLBACK)`,
  )
}

function settled<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  )
}

async function ensureActivationColumns(): Promise<void> {
  // Idempotent: CI migrates first; local DBs may lag. Keep aligned with T1 migration.
  await query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS activation_status text,
      ADD COLUMN IF NOT EXISTS local_password_set boolean
  `)
  await query(`
    UPDATE users
       SET activation_status = COALESCE(NULLIF(trim(activation_status), ''), 'activated'),
           local_password_set = COALESCE(local_password_set, TRUE)
     WHERE activation_status IS NULL OR local_password_set IS NULL
  `)
  await query(`
    ALTER TABLE users
      ALTER COLUMN activation_status SET DEFAULT 'activated',
      ALTER COLUMN local_password_set SET DEFAULT TRUE
  `).catch(() => {})
  // Best-effort NOT NULL — ignore if concurrent tests hold rows with null mid-flight
  await query(`ALTER TABLE users ALTER COLUMN activation_status SET NOT NULL`).catch(() => {})
  await query(`ALTER TABLE users ALTER COLUMN local_password_set SET NOT NULL`).catch(() => {})
}

async function seedUserAndInvite(inviteToken: string, opts?: { activationStatus?: string }) {
  const initialHash = await bcrypt.hash(INITIAL_PASSWORD, getBcryptSaltRounds())
  const activation = opts?.activationStatus ?? 'activated'
  await query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, must_change_password, activation_status, local_password_set,
       created_at, updated_at
     ) VALUES (
       $1, $2, 'Invite Race', $3, 'user', '[]'::jsonb,
       true, true, $4, false,
       NOW(), NOW()
     )
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       password_hash = EXCLUDED.password_hash,
       is_active = true,
       must_change_password = true,
       activation_status = EXCLUDED.activation_status,
       local_password_set = false,
       updated_at = NOW()`,
    [USER_ID, EMAIL, initialHash, activation],
  )
  await query(`DELETE FROM user_invites WHERE user_id = $1 OR invite_token = $2`, [USER_ID, inviteToken])
  await query(
    `INSERT INTO user_invites (
       user_id, email, product_mode, invite_token, status,
       last_sent_at, created_at, updated_at
     ) VALUES ($1, $2, 'platform', $3, 'pending', NOW(), NOW(), NOW())`,
    [USER_ID, EMAIL, inviteToken],
  )
}

async function readInviteStatus(inviteToken: string): Promise<string | null> {
  const r = await query<{ status: string }>(
    `SELECT status FROM user_invites WHERE invite_token = $1`,
    [inviteToken],
  )
  return r.rows[0]?.status ?? null
}

async function readPasswordHash(): Promise<string> {
  const r = await query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [USER_ID],
  )
  if (!r.rows[0]) throw new Error('user missing')
  return r.rows[0].password_hash
}

describeIfDatabase('invite accept concurrency + rollback (real DB)', () => {
  beforeAll(async () => {
    await ensureActivationColumns()
  })

  afterAll(async () => {
    await query(`DELETE FROM user_invites WHERE user_id = $1`, [USER_ID]).catch(() => {})
    await query(`DELETE FROM users WHERE id = $1`, [USER_ID]).catch(() => {})
  })

  beforeEach(async () => {
    await query(`DELETE FROM user_invites WHERE user_id = $1`, [USER_ID]).catch(() => {})
    await query(`DELETE FROM users WHERE id = $1`, [USER_ID]).catch(() => {})
  })

  it('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('two real connections + row-lock barrier: one winner, one 409-class ledger fail; only winner password sticks', async () => {
    const inviteToken = `${TOKEN_BASE}-concurrent`
    await seedUserAndInvite(inviteToken)

    const winHash = await bcrypt.hash(WIN_PASSWORD, getBcryptSaltRounds())
    const loseHash = await bcrypt.hash(LOSE_PASSWORD, getBcryptSaltRounds())

    const baseInput = {
      inviteToken,
      userId: USER_ID,
      email: EMAIL,
      requestedName: '',
    }

    await withHolder(async (holder, holderPid) => {
      // Deterministic barrier: hold the invite row with FOR UPDATE on a dedicated connection.
      await holder.query('BEGIN')
      await holder.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      const locked = await holder.query(
        `SELECT id, status FROM user_invites WHERE invite_token = $1 FOR UPDATE`,
        [inviteToken],
      )
      expect(locked.rows).toHaveLength(1)
      expect(locked.rows[0].status).toBe('pending')

      // Start first apply; require a real Lock waiter whose chain roots at holder.
      const first = settled(
        applyInviteAcceptanceWrites({ ...baseInput, passwordHash: winHash }),
      )
      const firstWaiterPid = await waitForDistinctWaiterChainRootedAtHolder(holderPid, [])
      expect(firstWaiterPid).not.toBe(holderPid)

      // Start second apply *while holder still holds the row*. Require a *different* waiter
      // PID also chain-rooted at holder (may wait behind firstWaiterPid). A mutation that
      // defers second until after holder ROLLBACK makes this wait time out → suite red.
      const second = settled(
        applyInviteAcceptanceWrites({ ...baseInput, passwordHash: loseHash }),
      )
      const secondWaiterPid = await waitForDistinctWaiterChainRootedAtHolder(holderPid, [
        firstWaiterPid,
      ])
      expect(secondWaiterPid).not.toBe(holderPid)
      expect(secondWaiterPid).not.toBe(firstWaiterPid)

      // Both backends were observed queued before release.
      // Release the barrier — production path races on status='pending' claim.
      await holder.query('ROLLBACK')

      const [a, b] = await Promise.all([first, second])
      const outcomes = [a, b]
      const wins = outcomes.filter((o) => o.ok)
      const losses = outcomes.filter((o) => !o.ok)

      expect(wins, 'exactly one concurrent accept must commit').toHaveLength(1)
      expect(losses, 'exactly one concurrent accept must fail').toHaveLength(1)
      expect(inviteAcceptWriteErrorCode(losses[0].error)).toBe(INVITE_LEDGER_CONSUME_FAILED)

      expect(await readInviteStatus(inviteToken)).toBe('accepted')

      // Race winner is whichever claim landed first after barrier release — not start order.
      const storedHash = await readPasswordHash()
      const matchWin = await bcrypt.compare(WIN_PASSWORD, storedHash)
      const matchLose = await bcrypt.compare(LOSE_PASSWORD, storedHash)
      expect(matchWin || matchLose, 'exactly one of the two offered passwords must stick').toBe(true)
      expect(matchWin && matchLose, 'both passwords must not stick').toBe(false)
      expect(await bcrypt.compare(INITIAL_PASSWORD, storedHash)).toBe(false)
    })
  })

  it('user UPDATE zero-row rolls back ledger consume (status stays pending)', async () => {
    const inviteToken = `${TOKEN_BASE}-rollback`
    // User is pending_activation → production WHERE activation_status='activated' matches zero rows.
    await seedUserAndInvite(inviteToken, { activationStatus: 'pending_activation' })
    const hash = await bcrypt.hash(WIN_PASSWORD, getBcryptSaltRounds())

    await expect(
      applyInviteAcceptanceWrites({
        inviteToken,
        userId: USER_ID,
        email: EMAIL,
        passwordHash: hash,
        requestedName: '',
      }),
    ).rejects.toMatchObject({ code: INVITE_TARGET_UPDATE_MISMATCH })

    // Critical: ledger must NOT stay accepted after a failed user write.
    expect(await readInviteStatus(inviteToken)).toBe('pending')

    const storedHash = await readPasswordHash()
    expect(await bcrypt.compare(INITIAL_PASSWORD, storedHash)).toBe(true)
    expect(await bcrypt.compare(WIN_PASSWORD, storedHash)).toBe(false)
  })

  it('source shape: ledger consume and user write share one transaction; pending predicate present', async () => {
    // Lightweight mutation fence: if someone splits the txn or drops status='pending',
    // these strings disappear from the production modules the real-DB goldens import.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const root = path.resolve(__dirname, '../../src/auth')
    const writes = await fs.readFile(path.join(root, 'invite-accept-writes.ts'), 'utf8')
    const ledger = await fs.readFile(path.join(root, 'invite-ledger.ts'), 'utf8')

    expect(writes).toContain('await transaction(async (client)')
    expect(writes).toContain('markInviteAccepted')
    expect(writes).toContain('UPDATE users')
    expect(writes).toContain("activation_status = 'activated'")
    // Both steps must use the same client (not a pool query after commit).
    expect(writes).toMatch(/markInviteAccepted\([\s\S]*client/)
    expect(writes).toMatch(/client\.query\([\s\S]*UPDATE users/)

    expect(ledger).toMatch(/status\s*=\s*'pending'/)
    expect(ledger).toContain('RETURNING')
  })
})
