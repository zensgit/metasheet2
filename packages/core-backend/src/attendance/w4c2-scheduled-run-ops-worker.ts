/**
 * W4C-2 P1-1 fix (#4612 verdict second gate round, 2026-07-27) — the WIRING layer that turns
 * the already-specified, already-tested pure functions in `w4c2-scheduled-run.ts` (amendment
 * section 1.7's recovery-sweep scan/step, section 1.1.2's `abandoned` transition) into live,
 * callable operations: a connection-per-transaction sweep tick loop, and a connection wrapper
 * for the admin abandon route. Neither function here adds a new transaction shape or a new
 * business rule — `w4c2-scheduled-run.ts`'s own module docstring already claims exclusivity for
 * both (the run-creation/resume/finalization/abandon transactions and the sweep step), and this
 * file imports rather than reimplements them.
 *
 * Authority:
 * docs/development/attendance-issue-4556-w4c2-scheduled-run-identity-amendment-20260726.md
 * section 1.7 ("No stuck absorbing state — recovery sweep, fully specified") and section 1.1.2
 * (the `abandoned` transition's authorization/lock-order/audit/concurrency/idempotency
 * contract).
 *
 * Sweep tick scope: section 1.7 describes TWO branches per candidate — "not yet terminal"
 * resumes the exact run and "all terminal" finalizes it. The transaction-local step determines
 * which branch applies. For the first branch, this worker requires a plugin-owned callback that
 * rebuilds the current rule/holiday/calendar context and resumes the exact scanned `run_id`.
 * Keeping that context outside core avoids a second policy implementation while keeping
 * generation allocation outside the recovery path.
 *
 * It does NOT unwedge a target-set-drift candidate
 * (`W4C2_SCHEDULED_RUN_RESUME_TARGET_SET_DRIFT`) — section 1.7's own closing sentence names
 * that run's exit explicitly: "A run that cannot progress...is closed by the explicit
 * `abandoned` transition." That is the OTHER half of this file, `abandonScheduledRunOnceV1`,
 * which is the wedge's actual exit — not the sweep.
 */
import type { Pool, PoolClient } from 'pg'
import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import { runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import { createAuthorizedAttendanceWriteContextV1 } from './w4c0-authorization'
import {
  abandonAttendanceScheduledRunV1,
  scanAttendanceScheduledRunSweepCandidatesV1,
  sweepAttendanceScheduledRunCandidateV1,
  type AttendanceScheduledRunAbandonOutcomeV1,
  type AttendanceScheduledRunAbandonReasonCodeV1,
  type AttendanceScheduledRunSweepCandidateV1,
} from './w4c2-scheduled-run'

// ---------------------------------------------------------------------------
// Recovery-sweep tick.
// ---------------------------------------------------------------------------

export interface AttendanceScheduledRunSweepTickResultV1 {
  readonly scanned: number
  readonly finalized: number
  readonly notReady: number
  readonly skipped: number
  readonly errored: number
  /** Total `state='running'` rows at scan time (includes the `scanned` candidates themselves)
   *  — the operator-facing starvation signal the fixed-prefix scan never exposed: a
   *  `backlogRemaining` that stays >= `limit` tick after tick means the sweep is not draining. */
  readonly backlogRemaining: number
  /**
   * #4770 follow-up (issue #4770; second-opinion NIT-refine on `attendance-4556-w4c2-scheduled-
   * run-identity-amendment`'s W4C-2 recovery-sweep, 2026-08-05): count of `state='running'` rows
   * that have NEVER been claimed by a scan (`last_attempt_at IS NULL`), read from the SAME
   * snapshot as `backlogRemaining` — same query, same transaction, taken AFTER this tick's own
   * scan/write-back (a row this tick just claimed is already stamped by the time this is read,
   * so it does not count itself; pinned by the gate-1 tick-2 assertion in
   * `attendance-w4c2-sweep-fairness.db.test.ts`, which goes red if this read moves before the
   * scan).
   *
   * `backlogRemaining` alone cannot separate "N rows still legitimately churning through a large
   * backlog" from "one row is permanently excluded from every scan": once `backlogRemaining >
   * limit`, `scanned < backlogRemaining` holds on EVERY tick regardless of which case is true.
   * `neverAttemptedRunning` is the un-claimable count, read as a TREND across ticks (same idiom
   * as `backlogRemaining`'s own doc comment), in two regimes:
   *  - `backlogRemaining <= limit` (steady state): every row is scanned this tick, so this reads
   *    the exact un-claimable count from tick 1 — no warm-up window at all.
   *  - `backlogRemaining > limit` (congested): under ordinary churn it drains toward 0 within
   *    `ceil(backlogRemaining / limit)` ticks, because every row eventually gets a first scan
   *    pass (`FOR UPDATE SKIP LOCKED` willing). Under a genuinely stuck candidate — a row lock
   *    held open forever by a hung/leaked transaction — `SKIP LOCKED` excludes that row from
   *    every scan, so it is never stamped and this counter FLOORS at (at least) the stuck count
   *    instead of ever reaching 0.
   * Values-free: a count, never the stuck run's id/org/date.
   */
  readonly neverAttemptedRunning: number
  /**
   * Owner-review P2 on #4779 (2026-08-05): `neverAttemptedRunning` has its own blind spot —
   * `MIN()` ignores NULL, so it structurally cannot see a row that WAS scanned/stamped once
   * (`last_attempt_at` already non-NULL) and is THEN excluded from every later scan by a
   * permanent row lock. That row's `last_attempt_at` freezes at its one-and-only stamp; it
   * never re-enters the never-attempted bucket (it is not NULL) and it is never re-selected
   * (`FOR UPDATE SKIP LOCKED` keeps skipping it), so `neverAttemptedRunning` reads 0 for it on
   * every subsequent tick — silently. `oldestRunningAttemptAgeSeconds` closes that gap: the age,
   * in seconds, of the STALEST `last_attempt_at` among `state='running'` rows (`now() - MIN(last_
   * attempt_at)`, same snapshot/transaction as `backlogRemaining` and `neverAttemptedRunning`,
   * same post-scan read ordering). A row this tick just (re-)stamped reads exactly `0` — `now()`
   * is transaction-stable in PostgreSQL (`transaction_timestamp()`), so a fresh stamp and this
   * read are the IDENTICAL value within one tick's transaction, not an epsilon.
   *
   * THREE regimes — not two; the operator-facing signal is BOUNDED-PLATEAU vs. UNBOUNDED-GROWTH,
   * never merely "zero vs. nonzero" (a congested-but-healthy backlog is legitimately nonzero on
   * most ticks; alerting on any nonzero reading pages an operator for nothing broken):
   *  - Steady state (`backlogRemaining <= limit`), healthy: every tick restamps every row, so
   *    this reads exactly `0` on EVERY tick — "does not grow" is the positive-control signature,
   *    not merely "stays low" (verified: `attendance-w4c2-sweep-fairness.db.test.ts`'s
   *    "owner-review P2" describe block, positive-control leg).
   *  - Congested (`backlogRemaining > limit`), healthy — no row permanently excluded: rotation
   *    can only touch `limit` rows per tick, so SOME rows are always "one tick behind" and this
   *    reads NONZERO on most ticks — but BOUNDED, not ever-growing, as long as every row keeps
   *    being re-selected on some bounded cadence. (The pre-existing 30-row/limit-25 fixtures in
   *    the SAME test file — both the `neverAttemptedRunning`-discriminating leg's locked case and
   *    its own positive control — are consistent with this: nonzero on ticks 2-3, not
   *    monotonically increasing between them. That is 3 ticks of evidence, not a proof of a
   *    specific plateau bound — no test in this file pins an exact tick-count formula for this
   *    regime; only "bounded vs. unbounded" is asserted, via the `>= 0` checks alongside those
   *    pre-existing fixtures' unchanged 7-field values.)
   *  - UNBOUNDED-GROWTH: a `running` row is PERMANENTLY EXCLUDED from every scan — its stamp
   *    never advances while every other row's does, so it becomes (and stays) the `MIN`, and the
   *    age climbs, tick after tick, by however much real wall-clock time has elapsed, with NONE of
   *    the other seven counters moving at all once the row's own scan-eligible siblings settle
   *    into their own steady rotation (see the "owner-review P2" discriminating-leg describe block
   *    in `attendance-w4c2-sweep-fairness.db.test.ts`). This is a REAL fault either way — the row
   *    genuinely never gets another resume/finalize attempt — but this field CANNOT tell you why,
   *    and there is more than one known mechanism (this list is not claimed closed):
   *     1. A held row lock excludes the row from `FOR UPDATE SKIP LOCKED` on every subsequent
   *        scan (the discriminating-leg fixture above constructs exactly this case).
   *     2. Sustained NULLS-FIRST arrival starvation, WITH NO LOCK HELD AT ALL: the scan's own
   *        `ORDER BY last_attempt_at ASC NULLS FIRST` (`w4c2-scheduled-run.ts`'s scan docstring:
   *        "keeps never-attempted rows — including brand-new ones — ahead of anything already
   *        attempted") means a sustained stream of brand-new `running` rows preempts an
   *        already-stamped row for every scan slot, indefinitely. Empirically reproduced at the
   *        production default `limit=25` (owner-review P2 on #4779, 2026-08-05): with a flat
   *        backlog and >=25 fresh never-attempted arrivals injected before each tick, a
   *        previously-stamped victim row's `last_attempt_at` freezes at its one scan while
   *        `scanned`/`backlogRemaining`/`neverAttemptedRunning` all stay flat — the IDENTICAL
   *        stuck signature this field exists to surface, produced with no lock anywhere.
   *    An earlier version of this comment claimed the `NULLS FIRST` rotation "guarantees every
   *    row is eventually re-selected" in the congested-healthy regime, and attributed
   *    UNBOUNDED-GROWTH solely to a held lock. RETRACTED (owner-review, fresh-gate pass,
   *    2026-08-05) — both claims are false and contradict `w4c2-scheduled-run.ts`'s own scan
   *    docstring, which mechanism 2 above exploits directly. Do NOT use "no lock found" to
   *    dismiss a climbing reading. Eliminating mechanism 2 (e.g. guaranteeing every row is
   *    re-selected within some bounded number of ticks) is a candidate fix to #4774's rotation —
   *    tracked as an owner-deferred #4770 follow-up, OUT OF SCOPE for this field and this PR.
   * `neverAttemptedRunning`'s own doc comment enumerates two regimes (steady state / congested)
   * for ITS OWN reading, not three — that pair is about whether IT reaches zero; this field's own
   * three-way split above is about whether IT plateaus or keeps climbing. Do not conflate the two
   * fields' regime lists.
   *
   * Complementary to, not a replacement for, `neverAttemptedRunning`: a row locked BEFORE its
   * first scan ever runs has `last_attempt_at IS NULL` forever, which `MIN()` ignores — that
   * case is invisible to THIS field by construction and remains `neverAttemptedRunning`'s job
   * alone. The two counters cover disjoint halves of "permanently UNSCANNED" — never-claimed vs.
   * claimed-once-then-frozen — NOT every way a run can become permanently stuck. A row that IS
   * re-scanned every tick but never reaches a terminal state (target-set-drift / `not_ready`
   * forever — the sweep design's own `abandoned`-transition escape hatch, not this sweep's job)
   * reads HEALTHY on BOTH counters: re-stamped every tick keeps this field near `0`, and it was
   * never NULL so `neverAttemptedRunning` reads `0` for it too. That state has its own signature
   * elsewhere (`finalized=0`, `notReady==scanned`, flat backlog) — do not read "both counters
   * flat/low" as proof nothing is stuck. Values-free: a derived duration (seconds), never the
   * stuck row's `last_attempt_at` timestamp itself, its id/org/date.
   *
   * Weak spots this gauge does NOT close (disclose to operators; do not silently assume away):
   *  - Single MIN aggregate, not per-row: once ANY post-scan-stuck row exists, `MIN` pins to it
   *    and climbs; a second/third stuck row that appears later is invisible underneath it
   *    (1-vs-many blindness) — this field can only say "at least one row is stuck", never how many.
   *  - Does not self-clear on partial recovery: when the OLDEST stuck row finally resolves, the
   *    gauge DROPS to the next-oldest stamp even though other rows may still be stuck — an
   *    absolute-threshold alert can be spuriously reset by an unrelated row's recovery.
   *  - Under concurrent scan workers, `now() - MIN(last_attempt_at)` can read slightly NEGATIVE:
   *    `now()` is this transaction's start time, and a second worker's scan can stamp a row after
   *    this transaction began but before this `MIN` is read. Cosmetic only — a genuinely stale row
   *    always dominates the `MIN`, so a negative reading cannot mask a stuck row.
   */
  readonly oldestRunningAttemptAgeSeconds: number
}

/**
 * #4770: values-free observability for the sweep tick — counts and closed-set outcome codes
 * ONLY, never an org id / user id / work date / run id (audit-surface values-free discipline).
 * `meta`'s type (`Record<string, number>`) makes this values-free BY CONSTRUCTION for STRING
 * values — TypeScript refuses to compile a caller that slips a string business value (an org id,
 * a user id) into `meta`. The type alone does NOT block a numeric business value (an epoch
 * timestamp, a numeric id) — a caller could type-check while doing that. What actually closes
 * that gap is this file's own PRODUCER (`sweepAttendanceScheduledRunsOnceV1` below emits ONLY
 * the eight named counters below, never a caller-supplied field) together with the RUNTIME checks
 * `attendance-w4c2-sweep-fairness.db.test.ts`'s "gate 3" describe block asserts against that
 * producer's actual output: a closed key set (`Object.keys(...).sort()` deep-equal against the
 * eight named keys, not a subset check — an extra key fails it) and a `typeof === 'number'` check
 * on every value (a smuggled string fails it). Those two RUNTIME assertions, not the `meta` type
 * alone, are what is actually load-bearing; the type is a compile-time deterrent for the obvious
 * mistake, not a proof.
 */
export interface AttendanceScheduledRunSweepTickLoggerV1 {
  info(event: string, meta: Record<string, number>): void
  warn(event: string, meta: Record<string, number>): void
}

const noopSweepTickLogger: AttendanceScheduledRunSweepTickLoggerV1 = {
  info: () => undefined,
  warn: () => undefined,
}

const SWEEP_DEFAULT_LIMIT = 25

export interface AttendanceScheduledRunSweepOptionsV1 {
  readonly limit?: number
  readonly recoverCandidate: (candidate: AttendanceScheduledRunSweepCandidateV1) => Promise<void>
  /** Default: a no-op logger (byte-identical to the pre-#4770 silent tick for any caller that
   *  does not opt in). */
  readonly logger?: AttendanceScheduledRunSweepTickLoggerV1
}

/**
 * One sweep tick: the scan runs in its OWN transaction (alongside a `backlogRemaining` /
 * `neverAttemptedRunning` read of the SAME `state='running'` snapshot the scan used), then EACH
 * candidate gets its OWN fresh
 * connection and its OWN transaction — never batched (section 1.7's own comment on
 * `sweepAttendanceScheduledRunCandidateV1`: "Intended to run as ONE candidate per its OWN
 * `runAttendanceResultOperationTransactionV1` call, never batched, so one stuck candidate
 * cannot block the others in the same scan"). A per-candidate exception is caught and counted,
 * never rethrown — values-free containment, independent of (and in addition to) the cron
 * caller's own per-(org, workDate) isolation one level up
 * (`plugins/plugin-attendance/index.cjs`'s `scheduleAutoAbsence`).
 *
 * #4770: emits exactly one values-free tick-summary log line per call (via `options.logger`,
 * default no-op) — the prior silence meant "the scheduler ignores the tick's return counts...
 * only a whole-job throw is logged", so a starving backlog produced zero signal short of a
 * hard failure. `errored > 0` additionally logs at `warn`.
 */
export async function sweepAttendanceScheduledRunsOnceV1(
  pool: Pick<Pool, 'connect'>,
  options: AttendanceScheduledRunSweepOptionsV1,
): Promise<AttendanceScheduledRunSweepTickResultV1> {
  const limit =
    Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : SWEEP_DEFAULT_LIMIT
  const logger = options.logger ?? noopSweepTickLogger

  const scanClient = (await pool.connect()) as unknown as PoolClient
  let candidates: readonly { orgId: string; initiator: string; workDate: string; runId: string }[]
  let backlogRemaining: number
  let neverAttemptedRunning: number
  let oldestRunningAttemptAgeSeconds: number
  try {
    ;({ candidates, backlogRemaining, neverAttemptedRunning, oldestRunningAttemptAgeSeconds } =
      await runAttendanceResultOperationTransactionV1(
        scanClient as unknown as AttendanceW4TransactionClientV1,
        async (trx) => {
          // Scan (and its own durable-rotation write-back) FIRST, then read the post-scan
          // snapshot below — ordering is load-bearing, see `neverAttemptedRunning`'s doc comment
          // on `AttendanceScheduledRunSweepTickResultV1`.
          const scanned = await scanAttendanceScheduledRunSweepCandidatesV1(trx, limit)
          const backlog = await trx.query(
            `SELECT count(*)::int AS n,
                    count(*) FILTER (WHERE last_attempt_at IS NULL) AS never_attempted,
                    EXTRACT(EPOCH FROM (now() - MIN(last_attempt_at)))::float8 AS oldest_attempt_age_seconds
               FROM attendance_scheduled_runs WHERE state = 'running'`,
          )
          const backlogRow = backlog.rows[0] as
            | { n?: number | string; never_attempted?: number | string; oldest_attempt_age_seconds?: number | string | null }
            | undefined
          return {
            candidates: scanned,
            backlogRemaining: Number(backlogRow?.n ?? 0),
            neverAttemptedRunning: Number(backlogRow?.never_attempted ?? 0),
            // `MIN(last_attempt_at)` is NULL when every `running` row is still un-stamped (or
            // there are no `running` rows at all) — `EXTRACT(EPOCH FROM NULL)` is then also NULL,
            // which `Number(... ?? 0)` floors to `0` (nothing stale to report, same "no signal"
            // convention the other two counters already use for their own empty case).
            oldestRunningAttemptAgeSeconds: Number(backlogRow?.oldest_attempt_age_seconds ?? 0),
          }
        },
      ))
  } finally {
    scanClient.release()
  }

  let finalized = 0
  let notReady = 0
  let skipped = 0
  let errored = 0
  for (const candidate of candidates) {
    const client = (await pool.connect()) as unknown as PoolClient
    let outcome: Awaited<ReturnType<typeof sweepAttendanceScheduledRunCandidateV1>> | null = null
    try {
      outcome = await runAttendanceResultOperationTransactionV1(
        client as unknown as AttendanceW4TransactionClientV1,
        (trx) => sweepAttendanceScheduledRunCandidateV1(trx, candidate as AttendanceScheduledRunSweepCandidateV1),
      )
    } catch {
      errored += 1
    } finally {
      client.release()
    }
    if (!outcome) continue
    if (outcome.kind === 'finalized') {
      finalized += 1
      continue
    }
    if (outcome.kind === 'not_ready') {
      try {
        await options.recoverCandidate(candidate as AttendanceScheduledRunSweepCandidateV1)
        notReady += 1
      } catch {
        errored += 1
      }
      continue
    }
    skipped += 1
  }

  const result = {
    scanned: candidates.length,
    finalized,
    notReady,
    skipped,
    errored,
    backlogRemaining,
    neverAttemptedRunning,
    oldestRunningAttemptAgeSeconds,
  }
  logger.info('attendance.w4_scheduled_run_sweep.tick', result)
  if (errored > 0) {
    logger.warn('attendance.w4_scheduled_run_sweep.tick_errors', result)
  }
  return result
}

// ---------------------------------------------------------------------------
// Admin abandon route — connection wrapper only; section 1.1.2's own
// authorization/lock-order/org-anchor/audit/concurrency/idempotency contract lives entirely
// inside `abandonAttendanceScheduledRunV1`.
// ---------------------------------------------------------------------------

export interface AttendanceScheduledRunAdminAbandonInputV1 {
  readonly orgId: string
  readonly runId: string
  readonly adminActorId: string
  readonly reasonCode: AttendanceScheduledRunAbandonReasonCodeV1
}

/**
 * Mints the branded authorization witness INSIDE this module from route-supplied plain data —
 * never from request JSON directly (the same "route submits pure data, private adapter mints"
 * pattern `w4c2-live-scheduled-boundary.ts`'s `adminRunScheduledAuthorization` already uses for
 * the SAME admin surface, including its posture choice: `platform_admin`, not
 * `attendance_admin`, because the route's own RBAC gate (`withPermission('attendance:admin',
 * ...)`) is a GLOBAL permission with no `org_id` column — `attendance_admin` posture would
 * newly require an active `user_orgs` row for the target org, silently narrowing an existing
 * cross-org capability).
 */
export async function abandonScheduledRunOnceV1(
  pool: Pick<Pool, 'connect'>,
  input: AttendanceScheduledRunAdminAbandonInputV1,
): Promise<AttendanceScheduledRunAbandonOutcomeV1> {
  const callerIdentity = createAuthorizedAttendanceWriteContextV1({
    actorId: input.adminActorId,
    actorPosture: 'platform_admin',
    tokenSubjectUserId: input.adminActorId,
    orgId: input.orgId,
    subjectScope: { kind: 'explicit_users', userIds: [input.adminActorId] },
    capability: 'retirement',
    sourceRef: 'ref:w4c2-scheduled-run-admin-abandon',
  })
  const client = (await pool.connect()) as unknown as PoolClient
  try {
    return await runAttendanceResultOperationTransactionV1(
      client as unknown as AttendanceW4TransactionClientV1,
      (trx) =>
        abandonAttendanceScheduledRunV1(trx, callerIdentity, { orgId: input.orgId, runId: input.runId }, input.reasonCode),
    )
  } finally {
    client.release()
  }
}
