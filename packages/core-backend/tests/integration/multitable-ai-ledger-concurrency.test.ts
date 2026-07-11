/**
 * Real-DB behavioral test for the AI usage ledger's concurrency no-compound
 * invariant (audit finding P3-3, closes the M4 coverage gap).
 *
 * The RESERVE-THEN-SETTLE header of ai-usage-ledger.ts promises: "N parallel
 * attempts cannot compound past the cap (each concurrent reserve sees earlier
 * in_flight estimates)". That guarantee is carried by ONE line of SQL — the
 * daily-token FILTER in `sumAiUsageWindows` (ai-usage-ledger.ts:163) does NOT
 * filter on `status`, so an unsettled `in_flight` reservation still counts
 * against the daily-token cap of the NEXT reserve.
 *
 * Before this file, that invariant was locked only by a UNIT SQL-SHAPE assertion
 * (`not.toContain('status')`). Adversarial mutation M4 — adding
 * `AND status <> 'in_flight'` to that daily FILTER — left ALL existing real-DB
 * integration tests GREEN, because they reserve-then-settle each row before the
 * next SUM runs, so no test ever had two reservations in_flight at the same time.
 * Two overlapping reserves could therefore compound past the cap with no test to
 * catch it. This file drives that exact scenario against real Postgres + the real
 * advisory locks and asserts the BEHAVIOR (the second reserve is rejected), so
 * M4 turns it RED.
 *
 * Non-vacuity is pinned to the mutated line by asserting the rejection
 * `reason === 'user_daily_tokens'` (M4's line) — the weekly-token and instance-USD
 * caps are set generously large so the daily-token check is the SOLE binding
 * constraint and no unmutated code path can reject the second reserve.
 *
 * Wired into .github/workflows/plugin-tests.yml multitable real-DB explicit list.
 */
import { afterAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  AI_USAGE_LEDGER_TABLE,
  AI_USAGE_RESERVATION_GRACE_MS,
  reserveAiUsage,
  sumAiUsageWindows,
  type AiUsagePool,
  type AiUsageQuotaCaps,
  type AiUsageReservationInput,
} from '../../src/services/ai-usage-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
// File-namespaced sheet id — afterAll deletes every row this file created (the
// in_flight reservation rows AND the quota_exhausted zero-rows) by this key.
const SHEET_ID = `sheet_aicc_${TS}`

// The pool exposes a per-transaction connection (ConnectionPool.transaction →
// pool.connect()), so each reserveAiUsage runs on its OWN connection and the
// pg advisory xact locks genuinely serialize concurrent reserves — production
// passes this same `poolManager.get()` object (routes/multitable-ai.ts).
const pool = poolManager.get() as unknown as AiUsagePool
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// Daily-token cap is the SOLE binding constraint. Each reserve estimates 60
// tokens (40 prompt + 20 completion): one alone (60) fits under 100, two
// together (120) do not. Weekly + USD caps are large so ONLY the daily-token
// FILTER (the M4-mutated line) can reject the second reserve.
const TOKEN_CAP = 100
const EST_PROMPT_TOKENS = 40
const EST_COMPLETION_TOKENS = 20
const CAPS: AiUsageQuotaCaps = {
  tenantDailyTokenCap: TOKEN_CAP,
  tenantWeeklyTokenCap: 1_000_000,
  accountDailyUsdCap: 1_000,
}

function reservationInput(subject: string): AiUsageReservationInput {
  return {
    subjectKey: subject,
    userId: subject,
    sheetId: SHEET_ID,
    fieldId: null,
    recordId: null,
    action: 'run',
    provider: 'test',
    model: 'test-model',
    estimatedPromptTokens: EST_PROMPT_TOKENS,
    estimatedCompletionTokens: EST_COMPLETION_TOKENS,
    estimatedCostUsd: 0.001,
    caps: CAPS,
    // Large stale window so the sweep never touches our in_flight rows mid-test.
    staleAfterMs: 3_600_000 + AI_USAGE_RESERVATION_GRACE_MS,
  }
}

async function tokenSum(subject: string): Promise<number> {
  const sums = await sumAiUsageWindows((sql, params) => q(sql, params), subject)
  return sums.userDailyTokens
}

async function statusCounts(subject: string): Promise<Record<string, number>> {
  const res = await q(
    `SELECT status, count(*)::int AS n FROM ${AI_USAGE_LEDGER_TABLE} WHERE subject_key = $1 GROUP BY status`,
    [subject],
  )
  const out: Record<string, number> = {}
  for (const r of res.rows as Array<{ status: string; n: number }>) out[r.status] = r.n
  return out
}

describeIfDatabase('AI usage ledger — concurrent-reserve no-compound (real DB)', () => {
  beforeEach(async () => {
    await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID])
  })

  afterAll(async () => {
    await q(`DELETE FROM ${AI_USAGE_LEDGER_TABLE} WHERE sheet_id = $1`, [SHEET_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('an unsettled in_flight reservation counts against the daily cap of the next reserve (M4 catcher)', async () => {
    const subject = `u_aicc_seq_${TS}`

    // Reserve 1 succeeds: 60 tokens fit under the 100 cap. It is now in_flight
    // and — critically — NOT settled.
    const first = await reserveAiUsage(pool, reservationInput(subject))
    expect(first.reserved).toBe(true)

    // Reserve 2 runs while reserve 1 is still in_flight. The daily-token SUM
    // (ai-usage-ledger.ts:163, unfiltered on status) sees reserve 1's 60 in_flight
    // tokens, so 60 + 60 = 120 > 100 → the second reserve MUST be rejected.
    //
    // Under mutation M4 (daily FILTER gains `AND status <> 'in_flight'`), reserve 1's
    // tokens vanish from the SUM, reserve 2 sees 0 + 60 = 60 ≤ 100 and is ADMITTED,
    // compounding to 120 past the cap → this assertion goes RED. That is the gap.
    const second = await reserveAiUsage(pool, reservationInput(subject))
    expect(second.reserved).toBe(false)
    // Pinned to the mutated line: the daily-token cap is the only binding one.
    if (second.reserved === false) {
      expect(second.reason).toBe('user_daily_tokens')
    }

    // Exactly one in_flight reservation exists — the cap was NOT compounded past.
    const counts = await statusCounts(subject)
    expect(counts.in_flight ?? 0).toBe(1)
    expect(counts.quota_exhausted ?? 0).toBe(1)

    // The counted daily tokens equal a single reservation's estimate, never both.
    expect(await tokenSum(subject)).toBe(EST_PROMPT_TOKENS + EST_COMPLETION_TOKENS)
  })

  test('two overlapping concurrent reserves admit exactly one (advisory-lock serialization)', async () => {
    const subject = `u_aicc_par_${TS}`

    // Fire both reserves concurrently. Each acquires its own connection and races
    // for the '__instance__' → subject advisory xact locks; the loser's quota
    // check runs only AFTER the winner commits its in_flight row (READ COMMITTED),
    // so it sees the winner's in_flight estimate and is rejected. Net: exactly one
    // admitted. Under M4 the loser's SUM excludes the winner's in_flight row and
    // BOTH are admitted (compounded past the cap) → this assertion goes RED.
    const [a, b] = await Promise.all([
      reserveAiUsage(pool, reservationInput(subject)),
      reserveAiUsage(pool, reservationInput(subject)),
    ])

    const admitted = [a, b].filter((r) => r.reserved === true)
    const rejected = [a, b].filter((r) => r.reserved === false)
    expect(admitted).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // The rejection is specifically the daily-token cap (the M4-mutated path).
    for (const r of rejected) {
      if (r.reserved === false) expect(r.reason).toBe('user_daily_tokens')
    }

    // Real ledger state confirms no compounding: one in_flight, one quota_exhausted.
    const counts = await statusCounts(subject)
    expect(counts.in_flight ?? 0).toBe(1)
    expect(counts.quota_exhausted ?? 0).toBe(1)
    expect(await tokenSum(subject)).toBe(EST_PROMPT_TOKENS + EST_COMPLETION_TOKENS)
  })
})
