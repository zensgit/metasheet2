/**
 * Multitable AI usage ledger + quota enforcement (A2).
 *
 * Design lock: docs/development/multitable-ai-shortcut-backend-a2-design-20260611.md §2.5
 * (+ the "Implementation reconcile 2026-06-11" note — RESERVE-THEN-SETTLE).
 *
 *  - Table `multitable_ai_usage_ledger` (migration
 *    zzzz20260611090000_create_multitable_ai_usage_ledger.ts) records every
 *    preview/run attempt EXCEPT rate_limited (429 never inserts — the response
 *    itself is the audit; avoids DB write amplification under bursts).
 *  - subject_key = user_id (authenticated, unforgeable). The header-backfilled
 *    tenantId (jwt-middleware.ts x-tenant-id) is FORBIDDEN as a quota subject.
 *    E-8/E-9/E-10's "TENANT" env naming is an approved contract — its runtime
 *    semantic is PER-USER until a real tenant model lands. Q-4 (USD) always
 *    aggregates instance-wide and locks on '__instance__'.
 *  - Tokens/cost are recorded whenever the provider returned usage, regardless
 *    of the downstream outcome (a version conflict still spent real money).
 *    Never-sent attempts (blocked/quota_exhausted/unsafe_input) record
 *    zero-token rows. Quota aggregation SUMs WITHOUT filtering on status.
 *  - Concurrency (review-fix F1, RESERVE-THEN-SETTLE): `reserveAiUsage` runs a
 *    SHORT transaction — pg advisory xact locks in FIXED order ('__instance__'
 *    first, then the subject; hashtext keying, autoNumber #1406 precedent) →
 *    sweep stale reservations → SUM check (in_flight reservations count) →
 *    INSERT an `in_flight` reservation row at a CONSERVATIVE estimate → COMMIT
 *    (locks + pooled connection release here; the provider call is NEVER made
 *    under the lock). `settleAiUsageReservation` later UPDATEs the row to the
 *    ACTUAL usage + final status. N parallel attempts cannot overshoot the cap
 *    because every concurrent reserve sees earlier in_flight estimates.
 *  - Stale-reservation safety: a crash between reserve and settle leaves an
 *    `in_flight` row counted against quota. The next reserve (any subject —
 *    the '__instance__' lock is always held first, so the global sweep is
 *    race-free) settles reservations older than the caller's staleAfterMs
 *    (requestTimeoutMs + 60s grace) to zero-usage status='abandoned'.
 *  - Never persists prompt or completion text; `error` is redacted pre-insert.
 */

import { randomUUID } from 'crypto'

import { redactString } from '../multitable/automation-log-redact'

export const AI_USAGE_LEDGER_TABLE = 'multitable_ai_usage_ledger'

/** Q-4 (instance daily USD) aggregation/lock subject. */
export const AI_USAGE_INSTANCE_SUBJECT_KEY = '__instance__'

export type AiUsageAction = 'preview' | 'run'

export type AiUsageLedgerStatus =
  | 'succeeded'
  | 'blocked'
  | 'quota_exhausted'
  | 'provider_error'
  | 'unsafe_input'
  | 'version_conflict'
  | 'write_failed'
  /** Reservation awaiting settle — counts against quota at its conservative estimate. */
  | 'in_flight'
  /** Stale reservation settled to zero usage by a later reserve's sweep. */
  | 'abandoned'

/** Grace added on top of requestTimeoutMs before an in_flight reservation is sweepable. */
export const AI_USAGE_RESERVATION_GRACE_MS = 60_000

export interface AiUsageLedgerEntry {
  /** Caller-fixed id (reservation rows need it for the later settle); defaults to a fresh `aiu_` uuid. */
  id?: string
  subjectKey: string
  userId: string
  sheetId: string
  fieldId?: string | null
  recordId?: string | null
  action: AiUsageAction
  provider?: string | null
  model?: string | null
  promptTokens: number
  completionTokens: number
  estimatedCostUsd: number
  status: AiUsageLedgerStatus
  durationMs?: number | null
  /** Redacted again at insert time (defense in depth). */
  error?: string | null
}

export interface AiUsageQuotaCaps {
  tenantDailyTokenCap: number
  tenantWeeklyTokenCap: number
  accountDailyUsdCap: number
}

export type AiUsageQuotaDecision =
  | { allowed: true }
  | { allowed: false; reason: 'user_daily_tokens' | 'user_weekly_tokens' | 'instance_daily_usd' }

export type AiUsageQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface AiUsagePool {
  transaction: <T>(handler: (client: { query: AiUsageQueryFn }) => Promise<T>) => Promise<T>
}

export function aiUsageSubjectLockKey(subjectKey: string): string {
  return `multitable:ai-usage:${subjectKey}`
}

/** Insert one ledger row. Caller owns the best-effort policy (catch + log). */
export async function insertAiUsageLedgerEntry(query: AiUsageQueryFn, entry: AiUsageLedgerEntry): Promise<void> {
  await query(
    `INSERT INTO ${AI_USAGE_LEDGER_TABLE}
       (id, subject_key, user_id, sheet_id, field_id, record_id, action, provider, model,
        prompt_tokens, completion_tokens, estimated_cost_usd, status, duration_ms, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      entry.id ?? `aiu_${randomUUID()}`,
      entry.subjectKey,
      entry.userId,
      entry.sheetId,
      entry.fieldId ?? null,
      entry.recordId ?? null,
      entry.action,
      entry.provider ?? null,
      entry.model ?? null,
      Math.max(0, Math.round(entry.promptTokens)),
      Math.max(0, Math.round(entry.completionTokens)),
      entry.estimatedCostUsd,
      entry.status,
      entry.durationMs ?? null,
      entry.error ? redactString(entry.error).slice(0, 500) : null,
    ],
  )
}

/**
 * Aggregate consumed tokens/USD for the quota windows. SUMs are NOT filtered
 * by status (§2.5: usage counts whatever the downstream outcome). Caller runs
 * this under `withAiUsageQuotaLock` and FAILS CLOSED (blocked) when it throws.
 */
export async function checkAiUsageQuota(
  query: AiUsageQueryFn,
  subjectKey: string,
  caps: AiUsageQuotaCaps,
): Promise<AiUsageQuotaDecision> {
  const result = await query(
    `SELECT
       COALESCE(SUM(prompt_tokens + completion_tokens) FILTER (
         WHERE subject_key = $1 AND occurred_at >= date_trunc('day', now())
       ), 0) AS user_daily_tokens,
       COALESCE(SUM(prompt_tokens + completion_tokens) FILTER (
         WHERE subject_key = $1
       ), 0) AS user_weekly_tokens,
       COALESCE(SUM(estimated_cost_usd) FILTER (
         WHERE occurred_at >= date_trunc('day', now())
       ), 0) AS instance_daily_usd
     FROM ${AI_USAGE_LEDGER_TABLE}
     WHERE occurred_at >= date_trunc('week', now())`,
    [subjectKey],
  )
  const row = (result.rows[0] ?? {}) as Record<string, unknown>
  const userDailyTokens = Number(row.user_daily_tokens ?? 0)
  const userWeeklyTokens = Number(row.user_weekly_tokens ?? 0)
  const instanceDailyUsd = Number(row.instance_daily_usd ?? 0)

  if (userDailyTokens >= caps.tenantDailyTokenCap) {
    return { allowed: false, reason: 'user_daily_tokens' }
  }
  if (userWeeklyTokens >= caps.tenantWeeklyTokenCap) {
    return { allowed: false, reason: 'user_weekly_tokens' }
  }
  if (instanceDailyUsd >= caps.accountDailyUsdCap) {
    return { allowed: false, reason: 'instance_daily_usd' }
  }
  return { allowed: true }
}

/**
 * Serialize the SHORT quota check+reserve transaction per subject. Advisory
 * XACT locks release automatically at COMMIT/ROLLBACK — the connection is held
 * only for the brief sweep+check+insert (review-fix F1: NEVER across the
 * provider call). Locks are taken in a fixed global order (instance, then
 * subject) so concurrent reserves queue instead of deadlock.
 */
export async function withAiUsageQuotaLock<T>(
  pool: AiUsagePool,
  subjectKey: string,
  fn: (query: AiUsageQueryFn) => Promise<T>,
): Promise<T> {
  return pool.transaction(async ({ query }) => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [aiUsageSubjectLockKey(AI_USAGE_INSTANCE_SUBJECT_KEY)])
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [aiUsageSubjectLockKey(subjectKey)])
    return fn(query)
  })
}

/**
 * Conservative reservation estimate for prompt tokens: 1 token per char.
 * Deliberately pessimistic — CJK text runs ≈1 token/char (a chars/4 heuristic
 * under-reserves Chinese prompts ~4× and opens a quota admission gap, delta
 * review NF-1); over-reserving only delays concurrent admissions until settle
 * writes the actual usage back.
 */
export function conservativePromptTokenEstimate(prompt: string): number {
  return Math.max(1, prompt.length)
}

export interface AiUsageReservationInput {
  subjectKey: string
  userId: string
  sheetId: string
  fieldId?: string | null
  recordId?: string | null
  action: AiUsageAction
  provider?: string | null
  model?: string | null
  /** Conservative estimate from the assembled prompt length (ceil(chars/4)). */
  estimatedPromptTokens: number
  /** Conservative estimate = caps.maxOutputTokens. */
  estimatedCompletionTokens: number
  /** Price-table estimate over the two token estimates. */
  estimatedCostUsd: number
  caps: AiUsageQuotaCaps
  /** in_flight rows older than this are settled to zero-usage 'abandoned' before the SUM check. */
  staleAfterMs: number
}

export type AiUsageReservationResult =
  | { reserved: true; reservationId: string }
  | { reserved: false; reason: 'user_daily_tokens' | 'user_weekly_tokens' | 'instance_daily_usd' }

/**
 * RESERVE step (review-fix F1): one SHORT locked transaction —
 *   advisory locks (instance → subject, fixed order)
 *   → sweep stale in_flight reservations (crash-orphaned; > staleAfterMs old)
 *     to zero-usage status='abandoned' (global sweep: safe because every
 *     reserve holds the '__instance__' lock first)
 *   → SUM quota check (in_flight estimates count — that is the no-overshoot
 *     guarantee; an exhausted window inserts the zero-usage quota_exhausted
 *     row in the same tx)
 *   → INSERT the 'in_flight' reservation row at the conservative estimate
 *   → COMMIT (locks + connection released; the provider call happens OUTSIDE).
 */
export async function reserveAiUsage(
  pool: AiUsagePool,
  input: AiUsageReservationInput,
): Promise<AiUsageReservationResult> {
  return withAiUsageQuotaLock(pool, input.subjectKey, async (query) => {
    await query(
      `UPDATE ${AI_USAGE_LEDGER_TABLE}
          SET status = 'abandoned', prompt_tokens = 0, completion_tokens = 0,
              estimated_cost_usd = 0, error = 'reservation abandoned: not settled within the stale grace window'
        WHERE status = 'in_flight'
          AND occurred_at < now() - ($1::bigint * interval '1 millisecond')`,
      [Math.max(0, Math.round(input.staleAfterMs))],
    )

    const decision = await checkAiUsageQuota(query, input.subjectKey, input.caps)
    // `in`-guard (not `!decision.allowed`): non-strict tsconfig, no boolean-discriminant narrowing.
    if ('reason' in decision) {
      await insertAiUsageLedgerEntry(query, {
        subjectKey: input.subjectKey,
        userId: input.userId,
        sheetId: input.sheetId,
        fieldId: input.fieldId ?? null,
        recordId: input.recordId ?? null,
        action: input.action,
        provider: input.provider ?? null,
        model: input.model ?? null,
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        status: 'quota_exhausted',
        error: `quota window exhausted: ${decision.reason}`,
      })
      return { reserved: false, reason: decision.reason }
    }

    const reservationId = `aiu_${randomUUID()}`
    await insertAiUsageLedgerEntry(query, {
      id: reservationId,
      subjectKey: input.subjectKey,
      userId: input.userId,
      sheetId: input.sheetId,
      fieldId: input.fieldId ?? null,
      recordId: input.recordId ?? null,
      action: input.action,
      provider: input.provider ?? null,
      model: input.model ?? null,
      promptTokens: input.estimatedPromptTokens,
      completionTokens: input.estimatedCompletionTokens,
      estimatedCostUsd: input.estimatedCostUsd,
      status: 'in_flight',
    })
    return { reserved: true, reservationId }
  })
}

export interface AiUsageSettlement {
  promptTokens: number
  completionTokens: number
  estimatedCostUsd: number
  status: AiUsageLedgerStatus
  provider?: string | null
  model?: string | null
  durationMs?: number | null
  /** Redacted again at settle time (defense in depth). */
  error?: string | null
}

/**
 * SETTLE step (review-fix F1): UPDATE the reservation row from the
 * conservative estimate to the ACTUAL usage + final status. Write-failure
 * paths re-settle the status KEEPING the actual usage (§2.5: the money was
 * spent whatever the downstream outcome). Caller owns the best-effort policy
 * (catch + log — never 500 a committed write over a ledger UPDATE).
 */
export async function settleAiUsageReservation(
  query: AiUsageQueryFn,
  reservationId: string,
  settlement: AiUsageSettlement,
): Promise<void> {
  await query(
    `UPDATE ${AI_USAGE_LEDGER_TABLE}
        SET prompt_tokens = $2, completion_tokens = $3, estimated_cost_usd = $4, status = $5,
            provider = COALESCE($6, provider), model = COALESCE($7, model),
            duration_ms = $8, error = $9
      WHERE id = $1`,
    [
      reservationId,
      Math.max(0, Math.round(settlement.promptTokens)),
      Math.max(0, Math.round(settlement.completionTokens)),
      settlement.estimatedCostUsd,
      settlement.status,
      settlement.provider ?? null,
      settlement.model ?? null,
      settlement.durationMs ?? null,
      settlement.error ? redactString(settlement.error).slice(0, 500) : null,
    ],
  )
}
