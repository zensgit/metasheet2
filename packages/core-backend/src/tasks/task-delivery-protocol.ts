/**
 * Task feature — delivery worker protocol pieces (M4 PR-3b design §6.4, §7.2–§7.4, §8.5). PURE,
 * no I/O. Added by PR-3b S1.
 *
 * The worker service claims, fences and finalises outbox rows; every rule it applies between those
 * statements lives here (gate 20: the judgement is not written inline in the service): the
 * constants, the attempt back-off ladder, the outcome classification with the effect fence, the
 * in-batch processing order, the event-family freshness bound, the outbound base-URL allowlist and
 * the option clamps. Channel error classes stay in the channel service; this module only sees the
 * `TaskDeliveryChannelResult` a channel returns.
 *
 * Items the owner ruled on 2026-10-07 are tagged RULED(2026-10-07); this PR's own choices stay
 * ASSUMPTION(task-m4).
 */

// ── Outcomes and the channel result shape ────────────────────────────────────────────────────────

/** The five terminal states a claimed row can be written to (design §7.1). */
export const TASK_DELIVERY_OUTCOMES = ['sent', 'retrying', 'failed', 'skipped', 'outcome_unknown'] as const
export type TaskDeliveryOutcome = (typeof TASK_DELIVERY_OUTCOMES)[number]

/** The seven-value `status` column (design §2); the worker's CAS clauses name subsets of it. */
export const TASK_DELIVERY_STATUSES = ['pending', 'retrying', 'sending', 'sent', 'failed', 'skipped', 'outcome_unknown'] as const
export type TaskDeliveryStatus = (typeof TASK_DELIVERY_STATUSES)[number]

/**
 * What a channel's `prepare` or `send` reports (design §3.3). `skip` = a determinate "do not send
 * to this recipient" before any send; `outcomeUnknown` = a send may have happened and its result is
 * not known; otherwise `retryable` says whether the determinate rejection may be tried again.
 */
export type TaskDeliveryChannelResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string; skip?: boolean; outcomeUnknown?: boolean }

// ── Constants (ASSUMPTION(task-m4): [own-3b-08]) ─────────────────────────────────────────────────

/** Rows claimed per batch; clamp bounds below. */
export const TASK_DELIVERY_BATCH_SIZE_DEFAULT = 50
export const TASK_DELIVERY_BATCH_SIZE_MIN = 1
export const TASK_DELIVERY_BATCH_SIZE_MAX = 200
/** Determinate retryable rejections before a row is `failed`. */
export const TASK_DELIVERY_MAX_ATTEMPTS_DEFAULT = 5
/** Timeout of the single external request a send makes, and of a token fetch (design §8.2). */
export const TASK_DINGTALK_REQUEST_TIMEOUT_MS = 10_000
/** Budget of a channel's `prepare` (identity, config, token) for one row; the first bound to fire on a slow token. */
export const TASK_DELIVERY_PREPARE_BUDGET_MS = 12_000
/** Allowance for the two materialisations around `prepare` (the reads before the fence that are not the channel's). */
export const TASK_DELIVERY_MATERIALISE_ALLOWANCE_MS = 3_000
/** Margin added to the request timeout when the fence renews the lease for the send. */
export const TASK_DELIVERY_FENCE_MARGIN_MS = 5_000
/** The lease the fence sets on the row: exactly one send plus margin (design §7.2). */
export const TASK_DELIVERY_SEND_LEASE_MS = TASK_DINGTALK_REQUEST_TIMEOUT_MS + TASK_DELIVERY_FENCE_MARGIN_MS
// ASSUMPTION(task-m4): [own-3b-36] the time one row may spend before the fence (payload check,
// materialisation, `prepare`, materialisation again): the prepare budget plus the materialisation
// allowance, strictly above the prepare budget, so a `prepare` that uses its whole budget and
// succeeds still leaves the row inside its own budget. A row over this budget is not fenced and
// ends as a bounded retry; while a row is over it, the rest of its batch is handed back, so one
// slow row never lets the lease run out on the rows queued behind it.
export const TASK_DELIVERY_ROW_BUDGET_MS = TASK_DELIVERY_PREPARE_BUDGET_MS + TASK_DELIVERY_MATERIALISE_ALLOWANCE_MS
/** Lease that must remain on the batch before a row is started (the row budget plus one send lease); otherwise the row is handed back. */
export const TASK_DELIVERY_ROW_RESERVE_MS = TASK_DELIVERY_ROW_BUDGET_MS + TASK_DELIVERY_SEND_LEASE_MS
/** Batch lease; clamp bounds below. */
export const TASK_DELIVERY_LEASE_MS_DEFAULT = 60_000
// ASSUMPTION(task-m4): [own-3b-24] lease clamp bounds. Floor = twice the per-row reserve, so a batch
// can always start at least one row and any clamped value satisfies the worker constructor's
// `leaseMs > TASK_DELIVERY_ROW_RESERVE_MS` assertion; ceiling = ten minutes.
export const TASK_DELIVERY_LEASE_MS_MIN = 2 * TASK_DELIVERY_ROW_RESERVE_MS
export const TASK_DELIVERY_LEASE_MS_MAX = 10 * 60_000
/** Time budget of one tick's delivery loop; below the default scheduler interval (design §6.4). */
export const TASK_DELIVERY_TICK_BUDGET_MS = 40_000

/** The defaults as one frozen object, for the worker constructor. */
export const TASK_DELIVERY_DEFAULTS = Object.freeze({
  batchSize: TASK_DELIVERY_BATCH_SIZE_DEFAULT,
  leaseMs: TASK_DELIVERY_LEASE_MS_DEFAULT,
  maxAttempts: TASK_DELIVERY_MAX_ATTEMPTS_DEFAULT,
  requestTimeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS,
  prepareBudgetMs: TASK_DELIVERY_PREPARE_BUDGET_MS,
  materialiseAllowanceMs: TASK_DELIVERY_MATERIALISE_ALLOWANCE_MS,
  fenceMarginMs: TASK_DELIVERY_FENCE_MARGIN_MS,
  sendLeaseMs: TASK_DELIVERY_SEND_LEASE_MS,
  rowReserveMs: TASK_DELIVERY_ROW_RESERVE_MS,
  rowBudgetMs: TASK_DELIVERY_ROW_BUDGET_MS,
  tickBudgetMs: TASK_DELIVERY_TICK_BUDGET_MS,
} as const)

// ASSUMPTION(task-m4): [own-3b-16] the two families with a time window are claimed first; the
// event and list families wait behind them (they have a 24 h freshness bound instead).
export const TASK_DELIVERY_PRIORITY_SOURCE_TYPES = ['task_reminder', 'task_daily'] as const

// ASSUMPTION(task-m4): [own-3b-14] an event-family or list-family row older than this at send time
// is `skipped` / `event_stale` with zero sends.
export const TASK_EVENT_NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000

// ── Back-off ─────────────────────────────────────────────────────────────────────────────────────

/** Delay before the next attempt, indexed by the attempt that just failed (1-based); the last
 * step repeats (design §7.3): 1 min, 5 min, 15 min, 1 h, 6 h. */
export const TASK_DELIVERY_BACKOFF_LADDER_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const

/** `next_attempt_at − now` after the `attemptCount`-th attempt was a determinate retryable rejection. */
export function computeTaskDeliveryBackoffMs(attemptCount: number): number {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new TypeError('computeTaskDeliveryBackoffMs: attemptCount must be an integer ≥ 1')
  }
  const index = Math.min(attemptCount, TASK_DELIVERY_BACKOFF_LADDER_MS.length) - 1
  return TASK_DELIVERY_BACKOFF_LADDER_MS[index]
}

// ── Outcome classification with the effect fence ─────────────────────────────────────────────────

export interface ClassifyTaskDeliveryOutcomeInput {
  /** What the channel returned — or whatever was thrown, when a step threw instead of returning. */
  result: unknown
  /** `attempt_count` of the row as claimed (≥ 0). */
  attemptCount: number
  /** The worker's `maxAttempts` (≥ 1). */
  maxAttempts: number
  /** Whether the row had passed the effect fence (`status = 'sending'`) when `result` arose. */
  fenced: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ASSUMPTION(task-m4): [own-3b-04] after the fence only a determinate rejection may let the row be
// sent again; everything that cannot be classified ends in `outcome_unknown` and is never re-sent.
// Before the fence nothing has been sent, so the only outcomes there are the three the design
// lists for that stage (skip / retryable / failed, design §7.2): a pre-fence result that claims a
// send (`ok: true`) or an unknown send outcome, a thrown error or a malformed return counts as a
// bounded retryable failure (design §7.3). `sent` and `outcome_unknown` therefore only ever follow
// the fence, matching the terminal CAS forms (`status = 'sending'` after the fence,
// `status IN ('pending','retrying')` before it).
/**
 * Truth table, after the fence (`fenced: true`):
 * - `{ ok: true }` ⇒ `sent`.
 * - `{ ok: false, outcomeUnknown: true }` ⇒ `outcome_unknown` (the channel's own uncertainty wins).
 * - `{ ok: false, skip: true }` ⇒ `outcome_unknown` (a skip cannot arise once a send was started).
 * - `{ ok: false, retryable: true }` ⇒ `retrying` while `attemptCount < maxAttempts`, else `failed`.
 * - `{ ok: false, retryable: false }` ⇒ `failed`.
 * - anything else ⇒ `outcome_unknown`.
 *
 * Before the fence (`fenced: false`):
 * - `{ ok: false, outcomeUnknown: true }`, whatever else it says ⇒ the bounded retry.
 * - `{ ok: false, skip: true }` ⇒ `skipped`.
 * - `{ ok: false, retryable: true }` ⇒ the bounded retry (`retrying`, or `failed` at `maxAttempts`).
 * - `{ ok: false, retryable: false }` ⇒ `failed`.
 * - anything else, including `{ ok: true }` ⇒ the bounded retry.
 */
export function classifyTaskDeliveryOutcome(input: ClassifyTaskDeliveryOutcomeInput): TaskDeliveryOutcome {
  if (!isRecord(input)) {
    throw new TypeError('classifyTaskDeliveryOutcome: input must be an object')
  }
  const { result, attemptCount, maxAttempts, fenced } = input
  if (!Number.isInteger(attemptCount) || attemptCount < 0) {
    throw new TypeError('classifyTaskDeliveryOutcome: attemptCount must be an integer ≥ 0')
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('classifyTaskDeliveryOutcome: maxAttempts must be an integer ≥ 1')
  }
  if (typeof fenced !== 'boolean') {
    throw new TypeError('classifyTaskDeliveryOutcome: fenced must be a boolean')
  }
  const retryOrFail = (): TaskDeliveryOutcome => (attemptCount < maxAttempts ? 'retrying' : 'failed')
  if (!fenced) {
    // Nothing has been sent: only a skip or a determinate non-retryable rejection ends the row here.
    if (isRecord(result) && result.ok === false && result.outcomeUnknown !== true) {
      if (result.skip === true) return 'skipped'
      if (result.retryable === false) return 'failed'
    }
    return retryOrFail()
  }
  if (isRecord(result)) {
    if (result.ok === true) return 'sent'
    if (result.ok === false) {
      if (result.outcomeUnknown === true) return 'outcome_unknown'
      if (result.skip === true) return 'outcome_unknown'
      if (result.retryable === true) return retryOrFail()
      if (result.retryable === false) return 'failed'
    }
  }
  return 'outcome_unknown'
}

// ── In-batch order ───────────────────────────────────────────────────────────────────────────────

/** The sort key of a claimed row (the claim statement's RETURNING columns, as Dates). */
export interface ClaimedDeliveryOrderKey {
  id: string
  sourceType: string
  nextAttemptAt: Date
  createdAt: Date
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Re-orders claimed rows the way the claim statement orders them (`UPDATE … RETURNING` has no
 * row order): priority families first, then `next_attempt_at`, `created_at`, `id` ascending.
 * Returns a new array; the input is not modified. Throws for a non-array or a malformed row.
 */
export function orderClaimedDeliveries<T extends ClaimedDeliveryOrderKey>(rows: readonly T[]): T[] {
  if (!Array.isArray(rows)) {
    throw new TypeError('orderClaimedDeliveries: rows must be an array')
  }
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row.id !== 'string' ||
      typeof row.sourceType !== 'string' ||
      !isValidDate(row.nextAttemptAt) ||
      !isValidDate(row.createdAt)
    ) {
      throw new TypeError('orderClaimedDeliveries: each row needs id, sourceType, nextAttemptAt, createdAt')
    }
  }
  const priority = (row: T): number =>
    (TASK_DELIVERY_PRIORITY_SOURCE_TYPES as readonly string[]).includes(row.sourceType) ? 0 : 1
  return [...rows].sort(
    (a, b) =>
      priority(a) - priority(b) ||
      a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      compareText(a.id, b.id),
  )
}

// ── Event-family freshness ───────────────────────────────────────────────────────────────────────

/** `true` once the row is older than `TASK_EVENT_NOTIFICATION_MAX_AGE_MS` (strictly; exactly 24 h is fresh). */
export function isTaskEventNotificationStale(createdAt: Date, now: Date): boolean {
  if (!isValidDate(createdAt) || !isValidDate(now)) {
    throw new TypeError('isTaskEventNotificationStale: createdAt and now must be valid Dates')
  }
  return now.getTime() - createdAt.getTime() > TASK_EVENT_NOTIFICATION_MAX_AGE_MS
}

// ── Outbound base URL (ASSUMPTION(task-m4): [own-3b-21]) ─────────────────────────────────────────

export const TASK_DINGTALK_BASE_HOST = 'oapi.dingtalk.com'
const TASK_DINGTALK_HOST_SUFFIX = '.dingtalk.com'

/**
 * Whether an integration's `baseUrl` may receive the task line's token and send requests: it must
 * parse as a URL (after trimming) with scheme `https:`, no user-info, and host `oapi.dingtalk.com`
 * or a non-empty label followed by `.dingtalk.com`. Any other value — another scheme, an IP, a host
 * that merely starts with the DingTalk name, user-info, or text that is not a URL — is refused and
 * the caller sends nothing. Never throws.
 */
export function isAllowedTaskDingTalkBaseUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  const host = parsed.hostname
  if (host === TASK_DINGTALK_BASE_HOST) return true
  return host.endsWith(TASK_DINGTALK_HOST_SUFFIX) && host.length > TASK_DINGTALK_HOST_SUFFIX.length
}

// ── Option clamps ────────────────────────────────────────────────────────────────────────────────

/** `[TASK_DELIVERY_BATCH_SIZE_MIN, TASK_DELIVERY_BATCH_SIZE_MAX]`; non-finite ⇒ the default; fractions floor. */
export function clampDeliveryBatchSize(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return TASK_DELIVERY_BATCH_SIZE_DEFAULT
  return Math.min(TASK_DELIVERY_BATCH_SIZE_MAX, Math.max(TASK_DELIVERY_BATCH_SIZE_MIN, Math.floor(n)))
}

/** `[TASK_DELIVERY_LEASE_MS_MIN, TASK_DELIVERY_LEASE_MS_MAX]`; non-finite ⇒ the default; fractions floor. */
export function clampDeliveryLeaseMs(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return TASK_DELIVERY_LEASE_MS_DEFAULT
  return Math.min(TASK_DELIVERY_LEASE_MS_MAX, Math.max(TASK_DELIVERY_LEASE_MS_MIN, Math.floor(n)))
}
