/**
 * Real-DB integration test for the AI usage ledger retention sweep (ladder #9).
 *
 * The M2 ledger (multitable_ai_usage_ledger) inserts a row for EVERY shortcut
 * attempt — incl. zero-token blocked/quota_exhausted rows — so the table grows
 * unbounded and a rate-limit storm is a DB-write amplification vector. The
 * retention sweep is a bounded DELETE of rows past the retention window
 * (default 90d, env-overridable, floored at 7d).
 *
 * KEYSTONE: a 90-day sweep must delete ONLY old rows and leave today/this-week
 * rows — and thus the live quota SUMs (sumAiUsageWindows) — UNTOUCHED. The
 * retention floor is always ≥ the widest quota window (date_trunc('week')), so
 * a sweep only ever deletes quota-inert rows.
 *
 * Seed rows at varied occurred_at (today, 3 days ago, 100 days ago) per subject,
 * then assert: (1) the sweep deletes only the >90d rows; (2) the subject's
 * quota SUMs are unchanged before vs after; (3) a disabled config is a no-op;
 * (4) a custom retention-days window is honored; (5) the scheduler tick drives
 * the sweep under the leader lock.
 *
 * Wired into .github/workflows/plugin-tests.yml multitable real-DB explicit list.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  AI_USAGE_LEDGER_TABLE,
  insertAiUsageLedgerEntry,
  sumAiUsageWindows,
  sweepAiUsageLedgerRetention,
  type AiUsageLedgerEntry,
} from '../../src/services/ai-usage-ledger'
import {
  LedgerRetentionScheduler,
  PgLedgerRetentionService,
} from '../../src/services/LedgerRetentionScheduler'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const SUBJECT = `u_ret_${TS}`
const SUBJECT_2 = `u_ret_b_${TS}`
const SHEET_ID = `sheet_ret_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

/** Insert a ledger row, then force its occurred_at to `daysAgo` days in the past. */
async function seedRow(
  subject: string,
  daysAgo: number,
  tokens: { prompt: number; completion: number },
  costUsd: number,
): Promise<void> {
  const id = `aiu_ret_${subject}_${daysAgo}_${Math.random().toString(36).slice(2, 8)}`
  const entry: AiUsageLedgerEntry = {
    id,
    subjectKey: subject,
    userId: subject,
    sheetId: SHEET_ID,
    action: 'run',
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
    estimatedCostUsd: costUsd,
    status: 'succeeded',
  }
  await insertAiUsageLedgerEntry((sql, params) => q(sql, params), entry)
  // Push occurred_at into the past — the DEFAULT NOW() is overwritten so we can
  // place rows on either side of the retention window deterministically.
  await q(
    `UPDATE ${AI_USAGE_LEDGER_TABLE} SET occurred_at = now() - ($2::int * interval '1 day') WHERE id = $1`,
    [id, daysAgo],
  )
}

async function countRows(subject: string): Promise<number> {
  const res = await q(`SELECT count(*)::int AS n FROM ${AI_USAGE_LEDGER_TABLE} WHERE subject_key = $1`, [subject])
  return (res.rows[0] as { n: number }).n
}

async function reseed(): Promise<void> {
  await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID])
  // Subject under test: 2 today, 1 at 3 days ago (both inside this week + within
  // 90 days → quota-counted and retention-safe), 2 at 100 days ago (past 90d).
  await seedRow(SUBJECT, 0, { prompt: 10, completion: 5 }, 0.001)
  await seedRow(SUBJECT, 0, { prompt: 7, completion: 3 }, 0.0007)
  await seedRow(SUBJECT, 3, { prompt: 100, completion: 50 }, 0.05) // this-week? only if within date_trunc('week')
  await seedRow(SUBJECT, 100, { prompt: 999, completion: 999 }, 9.99)
  await seedRow(SUBJECT, 100, { prompt: 999, completion: 999 }, 9.99)
  // A second subject contributing instance-wide USD today (Q-4 is instance-wide).
  await seedRow(SUBJECT_2, 0, { prompt: 1, completion: 1 }, 0.5)
  await seedRow(SUBJECT_2, 100, { prompt: 1, completion: 1 }, 5.0)
}

describeIfDatabase('AI usage ledger retention sweep (real DB)', () => {
  beforeAll(async () => {
    await reseed()
  })

  beforeEach(async () => {
    await reseed()
  })

  afterAll(async () => {
    await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('KEYSTONE: a 90-day sweep deletes only >90d rows and leaves quota SUMs untouched', async () => {
    const before = await sumAiUsageWindows((sql, params) => q(sql, params), SUBJECT)
    expect(await countRows(SUBJECT)).toBe(5)

    const deleted = await sweepAiUsageLedgerRetention((sql, params) => q(sql, params), {
      retentionDays: 90,
      disabled: false,
    })
    // Exactly the two 100-days-ago rows (this subject) — plus the second
    // subject's old row. Assert this subject's old rows went and the rest stayed.
    expect(deleted).toBeGreaterThanOrEqual(2)
    expect(await countRows(SUBJECT)).toBe(3) // 2 today + 1 at 3d ago survive

    const after = await sumAiUsageWindows((sql, params) => q(sql, params), SUBJECT)
    // The quota SUMs (daily/weekly tokens, instance daily USD) are byte-for-byte
    // unchanged: the deleted rows were ≥100 days old, far outside the weekly
    // window the SUM aggregates over.
    expect(after).toEqual(before)
  })

  test('the >90d rows are the only ones removed (the today/3d rows persist by id)', async () => {
    await sweepAiUsageLedgerRetention((sql, params) => q(sql, params), { retentionDays: 90, disabled: false })
    const remaining = await q(
      `SELECT EXTRACT(DAY FROM now() - occurred_at)::int AS age_days FROM ${AI_USAGE_LEDGER_TABLE} WHERE subject_key = $1`,
      [SUBJECT],
    )
    const ages = (remaining.rows as Array<{ age_days: number }>).map((r) => r.age_days)
    expect(ages.every((a) => a < 90)).toBe(true)
    expect(ages.some((a) => a >= 90)).toBe(false)
  })

  test('disabled config is a no-op (deletes 0, table unchanged)', async () => {
    const before = await countRows(SUBJECT)
    const deleted = await sweepAiUsageLedgerRetention((sql, params) => q(sql, params), {
      retentionDays: 90,
      disabled: true,
    })
    expect(deleted).toBe(0)
    expect(await countRows(SUBJECT)).toBe(before)
  })

  test('a custom retention-days window is honored (7-day window drops the 100d rows, keeps today+3d)', async () => {
    await sweepAiUsageLedgerRetention((sql, params) => q(sql, params), { retentionDays: 7, disabled: false })
    // 7-day window: today + 3d-ago survive (< 7d), the 100d rows are gone.
    expect(await countRows(SUBJECT)).toBe(3)
  })

  test('a custom retention-days window strictly between the row ages cuts at the right boundary', async () => {
    // 2-day window is floored to MIN (7) by the resolver, but the raw sweep
    // honors what it is given — pass 50d to land strictly between 3d and 100d.
    await sweepAiUsageLedgerRetention((sql, params) => q(sql, params), { retentionDays: 50, disabled: false })
    expect(await countRows(SUBJECT)).toBe(3) // today + 3d survive, 100d rows gone
  })

  test('the scheduler tick drives the sweep under the leader lock (PgLedgerRetentionService → real DB)', async () => {
    process.env.MULTITABLE_AI_LEDGER_RETENTION_DAYS = '90'
    try {
      // No leaderOptions → leader immediately (single-process). The default
      // service binds to poolManager + the env-resolved config and hits the real DB.
      const scheduler = new LedgerRetentionScheduler({ service: new PgLedgerRetentionService() })
      expect(scheduler.leader).toBe(true)

      const before = await sumAiUsageWindows((sql, params) => q(sql, params), SUBJECT)
      const deleted = await scheduler.tick()
      expect(deleted).toBeGreaterThanOrEqual(2) // the 100d rows
      expect(await countRows(SUBJECT)).toBe(3)

      // Quota SUMs still untouched after the scheduled sweep path.
      const after = await sumAiUsageWindows((sql, params) => q(sql, params), SUBJECT)
      expect(after).toEqual(before)

      scheduler.stop()
    } finally {
      delete process.env.MULTITABLE_AI_LEDGER_RETENTION_DAYS
    }
  })

  test('a follower scheduler does NOT sweep (leader gating)', async () => {
    process.env.MULTITABLE_AI_LEDGER_RETENTION_DAYS = '90'
    try {
      const { MemoryLeaderLockClient, RedisLeaderLock } = await import('../../src/multitable/redis-leader-lock')
      const store = new Map()
      const lockA = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
      const lockB = new RedisLeaderLock({ client: new MemoryLeaderLockClient(store) })
      const leader = new LedgerRetentionScheduler({
        service: new PgLedgerRetentionService(),
        leaderOptions: { leaderLock: lockA, ownerId: 'ret-a', ttlMs: 30_000 },
      })
      const follower = new LedgerRetentionScheduler({
        service: new PgLedgerRetentionService(),
        leaderOptions: { leaderLock: lockB, ownerId: 'ret-b', ttlMs: 30_000 },
      })
      await Promise.all([leader.ready, follower.ready])

      expect(follower.leader).toBe(false)
      const followerDeleted = await follower.tick()
      expect(followerDeleted).toBe(0) // follower no-ops
      expect(await countRows(SUBJECT)).toBe(5) // nothing swept by the follower

      const leaderDeleted = await leader.tick()
      expect(leaderDeleted).toBeGreaterThanOrEqual(2)
      expect(await countRows(SUBJECT)).toBe(3)

      leader.stop()
      follower.stop()
    } finally {
      delete process.env.MULTITABLE_AI_LEDGER_RETENTION_DAYS
    }
  })
})
