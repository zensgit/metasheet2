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

/**
 * `suggest` (M4 / Lane B2): NL→formula suggestion. Type-only addition — a
 * suggest row is SHEET-SCOPED (record_id/field_id NULL, both already nullable
 * per migration zzzz20260611090000); reserve/settle/quota SUM never filter by
 * scope so the windows are byte-identical to preview/run accounting.
 */
export type AiUsageAction = 'preview' | 'run' | 'suggest'

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

/** Numeric window sums shared by the quota decision and the A3 usage summary. */
export interface AiUsageWindowSums {
  userDailyTokens: number
  userWeeklyTokens: number
  instanceDailyUsd: number
}

/**
 * Aggregate consumed tokens/USD for the quota windows — the SINGLE SUM source
 * (A3 §2.4): `checkAiUsageQuota` derives its decision from these numbers and
 * the admin usage-summary route reports them directly. SUMs are NOT filtered
 * by status (§2.5: usage counts whatever the downstream outcome).
 */
export async function sumAiUsageWindows(
  query: AiUsageQueryFn,
  subjectKey: string,
): Promise<AiUsageWindowSums> {
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
  return {
    userDailyTokens: Number(row.user_daily_tokens ?? 0),
    userWeeklyTokens: Number(row.user_weekly_tokens ?? 0),
    instanceDailyUsd: Number(row.instance_daily_usd ?? 0),
  }
}

/**
 * Quota decision over the shared window sums. Caller runs this under
 * `withAiUsageQuotaLock` and FAILS CLOSED (blocked) when it throws.
 */
export async function checkAiUsageQuota(
  query: AiUsageQueryFn,
  subjectKey: string,
  caps: AiUsageQuotaCaps,
): Promise<AiUsageQuotaDecision> {
  const sums = await sumAiUsageWindows(query, subjectKey)

  if (sums.userDailyTokens >= caps.tenantDailyTokenCap) {
    return { allowed: false, reason: 'user_daily_tokens' }
  }
  if (sums.userWeeklyTokens >= caps.tenantWeeklyTokenCap) {
    return { allowed: false, reason: 'user_weekly_tokens' }
  }
  if (sums.instanceDailyUsd >= caps.accountDailyUsdCap) {
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

/**
 * Retention sweep (ladder #9): DELETE ledger rows older than the retention
 * window. The M2 ledger inserts a row for EVERY attempt (incl. zero-token
 * blocked/quota_exhausted rows) so a rate-limit storm is a DB-write
 * amplification vector and the table grows unbounded — this is the GAP the
 * migration header flagged (NiFi benchmark #1880).
 *
 * QUOTA NON-INTERFERENCE (the keystone): `sumAiUsageWindows` aggregates only
 * rows with `occurred_at >= date_trunc('week', now())` — at most ~7 days old.
 * The retention floor (DEFAULT 90, env floor 7 days) is always ≥ the quota
 * window, so a sweep can only delete rows that are ALREADY quota-inert. Quota
 * SUMs (daily/weekly tokens, instance daily USD) are untouched by any sweep.
 *
 * PLAIN DELETE, no aggregate-then-delete: quota SUMs are daily/weekly per the
 * reserve-then-settle design, so rows older than ~2 days are already
 * quota-inert; 90 days gives audit/cost-history headroom. The DELETE is
 * bounded per pass (ctid sub-select) so a backlog drains over several ticks
 * instead of one long-running statement under a rate-limit-storm table.
 */

/** Operational default retention window (env-overridable). */
export const AI_USAGE_LEDGER_RETENTION_DEFAULT_DAYS = 90

/**
 * Hard floor so an env mis-set (e.g. `0` / `1`) can never collapse the
 * retention window below the widest quota window (the weekly token cap), which
 * would let a sweep delete rows the quota SUMs still count.
 */
export const AI_USAGE_LEDGER_RETENTION_MIN_DAYS = 7

/** Per-pass DELETE bound — drains a backlog over ticks, never one huge statement. */
export const AI_USAGE_LEDGER_RETENTION_DEFAULT_BATCH = 5000

export interface AiUsageRetentionConfig {
  /** Resolved retention window in days (already floored). */
  retentionDays: number
  /** Opt-out: when true the sweep is a no-op (deletes 0). */
  disabled: boolean
  /** Per-pass row cap (defaults to AI_USAGE_LEDGER_RETENTION_DEFAULT_BATCH). */
  batchSize?: number
}

/**
 * Resolve the retention config from the environment. Defaults preserve today's
 * behavior except the new sweep (90-day window; on an empty/young table it
 * deletes 0). The retention window is floored at AI_USAGE_LEDGER_RETENTION_MIN_DAYS
 * to keep the foot-gun shut.
 */
export function resolveAiUsageRetentionConfig(env: NodeJS.ProcessEnv = process.env): AiUsageRetentionConfig {
  const disabled = env.MULTITABLE_AI_LEDGER_RETENTION_DISABLED === '1'
  const rawDays = Number(env.MULTITABLE_AI_LEDGER_RETENTION_DAYS)
  const requestedDays =
    Number.isFinite(rawDays) && rawDays > 0 ? rawDays : AI_USAGE_LEDGER_RETENTION_DEFAULT_DAYS
  const retentionDays = Math.max(AI_USAGE_LEDGER_RETENTION_MIN_DAYS, Math.floor(requestedDays))
  return { retentionDays, disabled }
}

/**
 * Delete ledger rows older than the retention window. Returns the number of
 * rows deleted (0 when disabled, or when nothing is past the window — the
 * empty/young-table case). The DELETE is bounded by `batchSize` via a ctid
 * sub-select so one pass never blocks the table during a backlog drain.
 *
 * CRITICAL: the cutoff is `now() - interval '<retentionDays> days'`. Because
 * `retentionDays >= AI_USAGE_LEDGER_RETENTION_MIN_DAYS (7) >=` the widest quota
 * window (`date_trunc('week', now())`), this can only delete quota-inert rows;
 * the live quota SUMs are never affected.
 */
export async function sweepAiUsageLedgerRetention(
  query: AiUsageQueryFn,
  config: AiUsageRetentionConfig,
): Promise<number> {
  if (config.disabled) return 0
  const retentionDays = Math.max(AI_USAGE_LEDGER_RETENTION_MIN_DAYS, Math.floor(config.retentionDays))
  const batchSize = Math.max(1, Math.floor(config.batchSize ?? AI_USAGE_LEDGER_RETENTION_DEFAULT_BATCH))
  const result = await query(
    `DELETE FROM ${AI_USAGE_LEDGER_TABLE}
      WHERE ctid IN (
        SELECT ctid FROM ${AI_USAGE_LEDGER_TABLE}
         WHERE occurred_at < now() - ($1::int * interval '1 day')
         LIMIT $2
      )`,
    [retentionDays, batchSize],
  )
  return result.rowCount ?? 0
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
