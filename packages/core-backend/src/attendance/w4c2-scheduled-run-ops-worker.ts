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
}

/**
 * #4770: values-free observability for the sweep tick — counts and closed-set outcome codes
 * ONLY, never an org id / user id / work date / run id (audit-surface values-free discipline).
 * `meta`'s type (`Record<string, number>`) makes this values-free BY CONSTRUCTION for STRING
 * values — TypeScript refuses to compile a caller that slips a string business value (an org id,
 * a user id) into `meta`. The type alone does NOT block a numeric business value (an epoch
 * timestamp, a numeric id) — a caller could type-check while doing that. What actually closes
 * that gap is this file's own PRODUCER (`sweepAttendanceScheduledRunsOnceV1` below emits ONLY
 * the six named counters below, never a caller-supplied field) together with the RUNTIME checks
 * `attendance-w4c2-sweep-fairness.db.test.ts`'s "gate 3" describe block asserts against that
 * producer's actual output: a closed key set (`Object.keys(...).sort()` deep-equal against the
 * six named keys, not a subset check — an extra key fails it) and a `typeof === 'number'` check
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
 * One sweep tick: the scan runs in its OWN transaction (alongside a `backlogRemaining` read of
 * the SAME `state='running'` snapshot the scan used), then EACH candidate gets its OWN fresh
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
  try {
    ;({ candidates, backlogRemaining } = await runAttendanceResultOperationTransactionV1(
      scanClient as unknown as AttendanceW4TransactionClientV1,
      async (trx) => {
        const scanned = await scanAttendanceScheduledRunSweepCandidatesV1(trx, limit)
        const backlog = await trx.query(
          `SELECT count(*)::int AS n FROM attendance_scheduled_runs WHERE state = 'running'`,
        )
        const backlogRow = backlog.rows[0] as { n?: number | string } | undefined
        return { candidates: scanned, backlogRemaining: Number(backlogRow?.n ?? 0) }
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

  const result = { scanned: candidates.length, finalized, notReady, skipped, errored, backlogRemaining }
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
