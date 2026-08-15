/**
 * W4C-2 Gate D3 (#4556 / #4844) — real-Postgres proof of the AUTHORITATIVE `scheduled` writer in
 * `src/attendance/w4c2-live-scheduled-boundary.ts`.
 *
 * WHAT THIS DRIVES: the production boundary factory (`createAttendanceLiveScheduledBoundaryV1`) over
 * a real pool, wired to the REAL plugin adapters exported at
 * `plugin-attendance/index.cjs :: __attendanceW4c2ScheduledAdaptersForTests` — the same functions
 * `activate` injects. Only the LIVE adapters (never exercised here) are throwing stubs. The scheduled
 * adapters are wrapped in call-count spies and an optional per-user FAULT map, which is what makes
 * (a) the P-A control-flow pin (zero `applyScheduledAbsenceLegacy` invocations on the authoritative
 * path) an observation rather than an argument, and (b) the containment scope negatives constructible
 * without inventing a seam.
 *
 * D3'S DISTINCTIVE RISK, and therefore this suite's centre of gravity: PER-TARGET FAILURE
 * CONTAINMENT. A refused target must be recorded as a terminal `'failed'` run outcome, its claimed
 * operation must be CANCELED before commit (the deferred `trg_aro_claimed_commit_guard` makes
 * committing a still-claimed operation illegal), the savepoint rollback must leave no orphan parent
 * behind, and the batch must CONTINUE. Everything outside the contained classes must still abort so
 * recovery/resume re-attempts the target instead of burning it terminally.
 *
 * WHY IT IS NOT PRODUCTION-REACHABLE ANYWAY: `effectiveState === 'authoritative'` additionally
 * requires an EXACT-org entry in `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` (wildcard never
 * counts). This suite sets that env for its own throwaway org ids; production leaves it unset, so
 * every production org collapses to `legacy` and the branch is unreachable irrespective of DB
 * contents.
 *
 * Shared-DB discipline: every fixture identity is a run-namespaced UUID; W4 calculation/operation/
 * outbox rows are append-only by design and are left behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import {
  createAttendanceLiveScheduledBoundaryV1,
  computeAuthoritativeScheduledPayloadFingerprintV1,
  type AttendancePluginShapedTrxV1,
  type AttendanceW4LiveScheduledBoundaryV1,
  type AttendanceW4LiveScheduledLegacyAdaptersV1,
} from '../../src/attendance/w4c2-live-scheduled-boundary'
import { computeAttendanceImportRollbackPreimageFingerprintV1 } from '../../src/attendance/w4c3a-import-rollback'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const TZ = 'UTC'
const WORK_DATE = '2026-06-08'

function uuid(): string {
  return crypto.randomUUID()
}

type ScheduledAdapters = {
  generateAbsenceRecords: (
    trx: AttendancePluginShapedTrxV1,
    orgId: string,
    workDate: string,
    timezone: string,
    userIds: readonly string[],
  ) => Promise<Array<{ user_id: string }>>
  resolveW4ScheduledCandidateInTransactionV1: (
    trx: AttendancePluginShapedTrxV1,
    args: unknown,
  ) => Promise<any>
  buildW4ShadowFrozenContextV1: (trx: AttendancePluginShapedTrxV1, args: unknown) => Promise<any>
}

/**
 * A per-user fault injected at a NAMED adapter seam. The boundary calls these seams from INSIDE the
 * authoritative branch's savepoint, so a fault is thrown exactly where a real refusal of that class
 * would be — which is what lets the scope negatives (untyped abort, non-contained typed abort,
 * retryable-SQLSTATE retry) be constructed at all.
 */
type Fault = {
  readonly userId: string
  readonly seam: 'resolveScheduledCandidate' | 'buildShadowFrozenContext'
  /** Called on each invocation for that user; return an error to throw, or null to pass through. */
  readonly make: (attempt: number) => unknown | null
}

describeIfDatabase('W4C-2 Gate D3 — authoritative scheduled writer (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let migrationDb: Kysely<unknown> | undefined
  let adapters: ScheduledAdapters
  let priorAllowlistEnv: string | undefined
  const allowlistedOrgs: string[] = []

  /** Registers an org in the exact-org env allowlist BEFORE any boundary call for it. */
  function allow(orgId: string): string {
    allowlistedOrgs.push(orgId)
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = allowlistedOrgs.join(',')
    return orgId
  }

  /**
   * Removes an org from the exact-org allowlist — the ONLY reachable mid-run demotion out of
   * `authoritative`. The rollout state machine's own edges out of `authoritative` go to `suspended`
   * and nowhere else (`attendance_w4_rollout_state_guard`), so a state-row demotion cannot express
   * "the org stopped being authoritative but the run keeps going"; withdrawing the env entry can,
   * and it is exactly the owner-actioned lever §2.3's byte-neutrality argument rests on.
   */
  function disallow(orgId: string): void {
    const index = allowlistedOrgs.indexOf(orgId)
    if (index >= 0) allowlistedOrgs.splice(index, 1)
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = allowlistedOrgs.join(',')
  }

  beforeAll(async () => {
    migrationDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }),
    })
    await up(migrationDb)
    priorAllowlistEnv = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    // The scheduled adapters are pure DB functions over the plugin-shaped `trx` (unlike the live
    // resolver, they need no `activate`-installed host port), so this suite requires no server boot.
    const { createRequire } = await import('module')
    const requireCjs = createRequire(import.meta.url)
    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW4c2ScheduledAdaptersForTests: ScheduledAdapters
    }
    adapters = plugin.__attendanceW4c2ScheduledAdaptersForTests
  }, 180000)

  afterAll(async () => {
    if (priorAllowlistEnv === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlistEnv
    await migrationDb?.destroy()
    await pool.end()
  })

  // ---- boundary driver ----------------------------------------------------

  interface Spies {
    applyScheduledAbsenceLegacy: number
    absenceUserIds: string[]
    resolveScheduledCandidate: number
    buildShadowFrozenContext: number
    /** Every statement the boundary issued through the canonical client, in order. */
    statements: string[]
  }

  function makeBoundary(faults: readonly Fault[] = []): {
    boundary: AttendanceW4LiveScheduledBoundaryV1
    spies: Spies
  } {
    const spies: Spies = {
      applyScheduledAbsenceLegacy: 0,
      absenceUserIds: [],
      resolveScheduledCandidate: 0,
      buildShadowFrozenContext: 0,
      statements: [],
    }
    const attempts = new Map<string, number>()
    function faultFor(seam: Fault['seam'], userId: string): unknown | null {
      const fault = faults.find((f) => f.seam === seam && f.userId === userId)
      if (!fault) return null
      const key = `${seam}:${userId}`
      const attempt = (attempts.get(key) ?? 0) + 1
      attempts.set(key, attempt)
      return fault.make(attempt)
    }
    const unreached = (name: string) => async () => {
      throw new Error(`W4C2_D3_LIVE_STUB_${name}_MUST_NOT_BE_REACHED`)
    }
    const legacyAdapters: AttendanceW4LiveScheduledLegacyAdaptersV1 = {
      applyLivePunchLegacy: unreached('applyLivePunchLegacy') as never,
      insertLivePunchEvent: unreached('insertLivePunchEvent') as never,
      deriveLivePunchWorkDateResolution: unreached('deriveLivePunchWorkDateResolution') as never,
      resolveLiveCandidate: unreached('resolveLiveCandidate') as never,
      applyScheduledAbsenceLegacy: (trx, args) => {
        spies.applyScheduledAbsenceLegacy += 1
        spies.absenceUserIds.push(...args.userIds)
        return adapters.generateAbsenceRecords(trx, args.orgId, args.workDate, args.timezone, args.userIds)
      },
      resolveScheduledCandidate: async (trx, args) => {
        spies.resolveScheduledCandidate += 1
        const injected = faultFor('resolveScheduledCandidate', String((args as { userId: string }).userId))
        if (injected !== null) throw injected
        return adapters.resolveW4ScheduledCandidateInTransactionV1(trx, args)
      },
      buildShadowFrozenContext: async (trx, args) => {
        spies.buildShadowFrozenContext += 1
        const injected = faultFor('buildShadowFrozenContext', String((args as { userId: string }).userId))
        if (injected !== null) throw injected
        return adapters.buildW4ShadowFrozenContextV1(trx, args)
      },
    }
    const boundary = createAttendanceLiveScheduledBoundaryV1({
      acquireConnection: async () => {
        const client = await pool.connect()
        const wrapped = {
          query: (sqlText: string, params?: unknown[]) => {
            spies.statements.push(sqlText.trim().split('\n')[0].trim())
            return (client as unknown as { query: (s: string, p?: unknown[]) => Promise<unknown> }).query(
              sqlText,
              params,
            )
          },
        } as unknown as AttendanceW4TransactionClientV1
        return { client: wrapped, release: () => client.release() }
      },
      legacyAdapters,
    })
    return { boundary, spies }
  }

  // ---- fixtures -----------------------------------------------------------

  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-2 d3 fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w4c2-d3.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }

  async function insertRolloutRow(orgId: string, state: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, $2, 'w4c2-d3', 'TEST_FIXTURE', 'w4c2-d3-actor', 1, NULL)`,
      [orgId, state],
    )
  }

  /** Walks the rollout row's legal edges to `authoritative` (the ops tool refuses this promotion). */
  async function walkRolloutToAuthoritative(orgId: string): Promise<void> {
    await insertRolloutRow(orgId, 'legacy')
    for (const [state, prior, version] of [
      ['shadow', 'legacy', 2],
      ['eligible', 'shadow', 3],
      ['authoritative', 'eligible', 4],
    ] as const) {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1`,
        [orgId, state, prior, version],
      )
    }
  }

  /**
   * `suspended` is not a legal INITIAL state and the only edge into it is from `authoritative`
   * (`attendance_w4_rollout_state_guard`), so the whole walk is required — a direct INSERT is
   * refused by the DB, which is why this helper exists rather than an `insertRolloutRow` call.
   */
  async function walkRolloutToSuspended(orgId: string): Promise<void> {
    await walkRolloutToAuthoritative(orgId)
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'suspended', prior_state = 'authoritative', version = 5
        WHERE org_id = $1`,
      [orgId],
    )
  }

  async function insertShiftAndAssignment(orgId: string, userId: string): Promise<string> {
    const shiftId = uuid()
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time, timezone)
       VALUES ($1, $2, $3, '09:00', '18:00', $4)`,
      [shiftId, orgId, `w4c2-d3-${RUN}-${shiftId.slice(0, 6)}`, TZ],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
       VALUES ($1, $2, $3, $4, 0, '2026-06-01', NULL, true, 'published', 'regular')`,
      [uuid(), orgId, userId, shiftId],
    )
    return shiftId
  }

  /**
   * An authoritative org plus `count` active users. `withShift` decides whether the freeze step can
   * resolve a `resolved_v2` attribution at all: WITH a shift the scheduled calculation reaches
   * `completed` (every segment `missing_both` over untimed `scheduled_absence` evidence ⇒ daily
   * status `absent` — an authoritative "generated absence day"); WITHOUT one the attribution is
   * `unsupported` and the calculation is `review_required`.
   */
  async function seedAuthoritativeOrg(
    count: number,
    options: { withShift?: boolean; state?: string } = {},
  ): Promise<{ orgId: string; userIds: string[] }> {
    const orgId = allow(uuid())
    const userIds: string[] = []
    for (let i = 0; i < count; i += 1) {
      const userId = uuid()
      await insertActiveUser(userId, orgId)
      if (options.withShift === true) await insertShiftAndAssignment(orgId, userId)
      userIds.push(userId)
    }
    if (options.state === undefined) await walkRolloutToAuthoritative(orgId)
    else await insertRolloutRow(orgId, options.state)
    return { orgId, userIds }
  }

  function scheduledInput(orgId: string, userIds: readonly string[], workDate = WORK_DATE) {
    return {
      orgId,
      workDate,
      timezone: TZ,
      targetUserIds: [...userIds],
      reviewTargets: [] as ReadonlyArray<{ userId: string; reasonCode: string }>,
      initiator: 'cron' as const,
      adminActorId: null,
    }
  }

  // ---- readers ------------------------------------------------------------

  const recordRows = async (orgId: string, userId?: string) =>
    (await pool.query(
      `SELECT id::text AS id, user_id, work_date::text AS work_date, status,
              first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes,
              projection_owner, current_calculation_id::text AS current_calculation_id,
              visibility_state, visibility_reason, updated_at
         FROM attendance_records
        WHERE org_id = $1 AND ($2::text IS NULL OR user_id = $2)
        ORDER BY user_id`,
      [orgId, userId ?? null],
    )).rows

  const calcRows = async (orgId: string, recordId?: string) =>
    (await pool.query(
      `SELECT id::text AS id, attendance_record_id::text AS attendance_record_id, version,
              calculation_kind, entrypoint, outcome, outcome_reason_code, projection_effect,
              operation_id::text AS operation_id, input_provenance, projected_status,
              expected_segment_count, calculation_tier
         FROM attendance_record_calculations
        WHERE org_id = $1 AND ($2::text IS NULL OR attendance_record_id = $2::uuid)
        ORDER BY version`,
      [orgId, recordId ?? null],
    )).rows

  /**
   * `attendance_result_operations` carries no subject column, so the per-target user is recovered
   * through the durable run target row that OWNS the operation id — the same join the run registry
   * itself uses, not a fabricated correlation.
   */
  const operationRows = async (orgId: string) =>
    (await pool.query(
      `SELECT o.operation_id::text AS operation_id, o.state, o.response_snapshot,
              o.resolved_calculation_id::text AS resolved_calculation_id,
              o.resolved_record_id::text AS resolved_record_id,
              t.user_id AS subject_user_id
         FROM attendance_result_operations o
         JOIN attendance_scheduled_run_targets t
              ON t.operation_id = o.operation_id AND t.org_id = o.org_id
        WHERE o.org_id = $1 AND o.entrypoint = 'scheduled'
        ORDER BY o.created_at`,
      [orgId],
    )).rows

  const runRows = async (orgId: string, workDate = WORK_DATE) =>
    (await pool.query(
      `SELECT run_id::text AS run_id, initiator, work_date::text AS work_date, generation, state,
              expected_user_count, review_count, completed_user_count, generated_count
         FROM attendance_scheduled_runs
        WHERE org_id = $1 AND work_date = $2::date
        ORDER BY generation ASC`,
      [orgId, workDate],
    )).rows

  const outcomeRows = async (orgId: string) =>
    (await pool.query(
      `SELECT t.user_id, o.terminal_outcome, o.failure_reason_code
         FROM attendance_scheduled_run_target_outcomes o
         JOIN attendance_scheduled_run_targets t ON t.id = o.target_id AND t.org_id = o.org_id
        WHERE o.org_id = $1
        ORDER BY t.user_id`,
      [orgId],
    )).rows

  const outboxRows = async (orgId: string) =>
    (await pool.query(
      `SELECT identity_kind, event_kind, payload, scheduled_run_id::text AS scheduled_run_id
         FROM attendance_result_event_outbox
        WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    )).rows

  /**
   * Retires a LEGACY-untracked parent with `import_rollback`, as pure fixture state BEFORE the run
   * is created — constructible precisely because `'generate'` targets are NOT NOT-EXISTS-filtered at
   * run creation, so a pre-existing retired row is an ordinary starting state for a target.
   *
   * `operator_retirement` is NOT installable this way: `attendance_w4_records_pointer_guard` refuses
   * a `legacy_untracked` parent carrying that reason ("operator retirement requires a W4 pointer").
   * Leg 6a therefore builds its fixture through the core's own reversal writer — fabricating an
   * impossible row would have made that leg vacuous.
   */
  async function retireParent(orgId: string, userId: string, workDate = WORK_DATE): Promise<string> {
    const recordId = uuid()
    await pool.query(
      `INSERT INTO attendance_records
         (id, org_id, user_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
          projection_owner, current_calculation_id, visibility_state, visibility_reason,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4::date, $5, NULL, NULL, 0, 0, 0, 'normal', true, '{}'::jsonb,
               'legacy_untracked', NULL, 'retired', 'import_rollback', now(), now())`,
      [recordId, orgId, userId, workDate, TZ],
    )
    return recordId
  }

  /**
   * Builds a genuinely `operator_retirement`-retired parent the way production does: an authoritative
   * completed scheduled target takes W4 ownership of the day, then the core's OWN reversal writer
   * retires it. The DB pointer guard validates the result end to end (pointer target must be an
   * authoritative reversed row with effect `set_retired`, reason `operator_retirement`, and the
   * parent's daily fields must equal its frozen snapshot), so this is a REAL row, not a state the
   * schema would never produce — and not a hand-written UPDATE the guard would refuse anyway.
   */
  async function retireParentOperatorRetirement(
    orgId: string,
    userId: string,
    workDate: string,
  ): Promise<void> {
    const { boundary } = makeBoundary()
    const seedRun = await boundary.executeScheduledRun(scheduledInput(orgId, [userId], workDate))
    expect(seedRun.kind).toBe('w4')
    const promoted = (await recordRows(orgId, userId)).find((r) => r.work_date === workDate)
    expect(promoted?.projection_owner).toBe('w4')
    const { projectedDailyFingerprintV1, writeAuthoritativeReversalV1 } = await import(
      '../../src/attendance/w4c2-authoritative-calculation-core'
    )
    const retiredProjection = {
      status: 'absent',
      firstInAt: null,
      lastOutAt: null,
      workMinutes: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await writeAuthoritativeReversalV1(client as unknown as AttendanceW4TransactionClientV1, {
        orgId,
        recordId: String(promoted?.id),
        entrypoint: 'ops_retirement',
        operationId: uuid(),
        supersedesCalculationId: String(promoted?.current_calculation_id),
        reversedSnapshots: {
          semanticInputFingerprint: 'a'.repeat(64),
          provenanceFingerprint: 'a'.repeat(64),
          sourceDefinitionFingerprint: 'a'.repeat(64),
          attributionSnapshot: {
            posture: 'unsupported',
            sourceSchemaVersion: 1,
            reason: 'legacy_v1',
            sourceFingerprint: null,
          },
          contextSnapshot: { schemaVersion: 1, kind: 'w4c2_d3_fixture_context' },
          evidenceSnapshot: [],
          approvedFactsSnapshot: [],
          manualOverrideSnapshot: null,
        },
        inputProvenance: { schemaVersion: 1, kind: 'w4c2_d3_fixture' },
        preimage: { posture: 'absent' },
        frozenTarget: {
          visibilityState: 'retired',
          visibilityReason: 'operator_retirement',
          projection: retiredProjection,
          dailyFingerprint: projectedDailyFingerprintV1({
            status: retiredProjection.status,
            firstInAt: null,
            lastOutAt: null,
            workedMinutes: 0,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
          }),
        },
        restoresCalculationId: null,
        outcomeReasonCode: 'operator_retirement',
        mergePolicy: 'retire',
        actorId: `w4c2-d3-${RUN}`,
        correlationId: `w4c2-d3-${RUN}`,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    // The fixture is REAL: assert the row actually reached the state under test, so a silently
    // skipped retirement cannot make the leg vacuous.
    const retired = (await recordRows(orgId, userId)).find((r) => r.work_date === workDate)
    expect(retired?.visibility_state).toBe('retired')
    expect(retired?.visibility_reason).toBe('operator_retirement')
  }

  // =========================================================================
  // Legs.
  // =========================================================================

  it('leg 1 — F6 fresh review, parent ABSENT: create-if-absent placeholder + review calc, NO legacy-ACTIVE absent row anywhere', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(1)
    const { boundary, spies } = makeBoundary()
    const result = await boundary.executeScheduledRun(scheduledInput(orgId, userIds))

    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')
    expect(result.perUser).toEqual([{ userId: userIds[0], mode: 'executed', inserted: false }])
    expect(result.rows).toEqual([])

    const records = await recordRows(orgId)
    expect(records.length).toBe(1)
    // The §7.5 F6 four-tuple, and the §7.5 pin: NO legacy-ACTIVE `'absent'` row was fabricated.
    expect(records[0]).toMatchObject({
      projection_owner: 'legacy_untracked',
      current_calculation_id: null,
      visibility_state: 'retired',
      visibility_reason: 'review_placeholder',
    })
    expect(records[0].first_in_at).toBeNull()
    expect(records[0].last_out_at).toBeNull()
    expect(
      records.filter((r) => r.status === 'absent' && r.visibility_state === 'active').length,
    ).toBe(0)

    const calcs = await calcRows(orgId, String(records[0].id))
    expect(calcs.length).toBe(1)
    expect(calcs[0]).toMatchObject({
      calculation_kind: 'calculation',
      entrypoint: 'scheduled',
      outcome: 'review_required',
      projection_effect: 'none',
      calculation_tier: 'segment_authoritative',
    })
    const children = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_record_segments WHERE calculation_id = $1::uuid`,
      [calcs[0].id],
    )
    expect(children.rows[0].n).toBe(0)

    // Seal contract PRESERVED: exactly `{inserted}` plus the resolved calculation id.
    const ops = await operationRows(orgId)
    expect(ops.length).toBe(1)
    expect(ops[0].state).toBe('completed')
    expect(ops[0].response_snapshot).toEqual({ inserted: false })
    expect(ops[0].resolved_calculation_id).toBe(calcs[0].id)

    expect(await outcomeRows(orgId)).toEqual([
      { user_id: userIds[0], terminal_outcome: 'completed', failure_reason_code: null },
    ])
    // P-A: the legacy absence adapter was never invoked on this path.
    expect(spies.applyScheduledAbsenceLegacy).toBe(0)
  })

  it('leg 2 [GATING] — fresh COMPLETED, parent ABSENT: placeholder created then promoted to w4/active/active, and NO legacy_baseline row', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(1, { withShift: true })
    const { boundary, spies } = makeBoundary()
    const result = await boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')
    expect(result.perUser).toEqual([{ userId: userIds[0], mode: 'executed', inserted: true }])
    expect(result.rows).toEqual([{ user_id: userIds[0] }])

    const records = await recordRows(orgId)
    expect(records.length).toBe(1)
    // ONE ATOMIC PROMOTION: the retired/review_placeholder row the branch installed is flipped by
    // the core's own tail pointer UPDATE, in the same transaction.
    expect(records[0]).toMatchObject({
      projection_owner: 'w4',
      visibility_state: 'active',
      visibility_reason: 'active',
      // A scheduled absence day: every segment `missing_both` over untimed evidence.
      status: 'absent',
    })
    expect(records[0].current_calculation_id).not.toBeNull()

    const calcs = await calcRows(orgId, String(records[0].id))
    // The GATING assertion: a `retired`/`review_placeholder` parent matches NEITHER the
    // `w4`-supersedes arm nor the `legacy_untracked`+active baseline arm, so no baseline is written.
    expect(calcs.map((c) => c.calculation_kind)).toEqual(['calculation'])
    expect(calcs.filter((c) => c.calculation_kind === 'legacy_baseline').length).toBe(0)
    expect(calcs[0]).toMatchObject({
      outcome: 'completed',
      entrypoint: 'scheduled',
      projected_status: 'absent',
      calculation_tier: 'segment_authoritative',
    })
    expect(String(records[0].current_calculation_id)).toBe(String(calcs[0].id))

    const ops = await operationRows(orgId)
    expect(ops[0].response_snapshot).toEqual({ inserted: true })
    expect(spies.applyScheduledAbsenceLegacy).toBe(0)
    // Non-vacuity for the whole `withShift` fixture family: the freeze step really resolved.
    expect(spies.buildShadowFrozenContext).toBeGreaterThan(0)
  })

  it('leg 3 — zero-invocation spy (the scheduled P-A pin): authoritative run invokes applyScheduledAbsenceLegacy ZERO times; the shadow control invokes it once per target', async () => {
    const authoritative = await seedAuthoritativeOrg(3, { withShift: true })
    const { boundary, spies } = makeBoundary()
    await boundary.executeScheduledRun(scheduledInput(authoritative.orgId, authoritative.userIds))
    expect(spies.applyScheduledAbsenceLegacy).toBe(0)
    expect(spies.absenceUserIds).toEqual([])

    // NEGATIVE CONTROL — same code path, shadow posture: the adapter IS called, once per target.
    // Without this the zero above could mean "the run did nothing at all".
    // NOTE the `allow`: `shadow` is an ENV-gated posture too — an org with a `shadow` rollout row
    // but no exact-org allowlist entry collapses to `legacy` and would take the probe's legacy
    // batch arm instead, making this "control" measure a different code path entirely.
    const shadowOrg = allow(uuid())
    const shadowUsers: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const userId = uuid()
      await insertActiveUser(userId, shadowOrg)
      shadowUsers.push(userId)
    }
    await insertRolloutRow(shadowOrg, 'shadow')
    const shadow = makeBoundary()
    const shadowResult = await shadow.boundary.executeScheduledRun(scheduledInput(shadowOrg, shadowUsers))
    expect(shadowResult.kind).toBe('w4')
    expect(shadow.spies.applyScheduledAbsenceLegacy).toBe(3)
    expect(shadow.spies.absenceUserIds.sort()).toEqual([...shadowUsers].sort())
  })

  it('leg 4a [GATING] + 6b — guard-409 (import_rollback) is CONTAINED: target 2 records failed, targets 1 and 3 complete, the batch never aborts, and the retired parent is bit-identical', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    // Pure DB fixture state, seeded BEFORE the run is created — no timing, no injected stub.
    // Constructible precisely because `'generate'` targets are NOT NOT-EXISTS-filtered at run
    // creation (`runAutoAbsenceForOrgDate` derives them from active membership alone).
    const retiredRecordId = await retireParent(orgId, userIds[1])
    const before = (await recordRows(orgId, userIds[1]))[0]

    const { boundary, spies } = makeBoundary()
    const result = await boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')

    // THE CONTAINMENT ASSERTION: the batch continued past the refusal.
    expect(result.perUser).toEqual([
      { userId: userIds[0], mode: 'executed', inserted: true },
      { userId: userIds[1], mode: 'failed', inserted: false },
      { userId: userIds[2], mode: 'executed', inserted: true },
    ])
    expect(result.rows).toEqual([{ user_id: userIds[0] }, { user_id: userIds[2] }])

    expect(await outcomeRows(orgId)).toEqual(
      [
        { user_id: userIds[0], terminal_outcome: 'completed', failure_reason_code: null },
        {
          user_id: userIds[1],
          terminal_outcome: 'failed',
          failure_reason_code: 'ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED',
        },
        { user_id: userIds[2], terminal_outcome: 'completed', failure_reason_code: null },
      ].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
    )

    const runs = await runRows(orgId)
    expect(runs.length).toBe(1)
    expect(runs[0]).toMatchObject({
      state: 'completed',
      expected_user_count: 3,
      completed_user_count: 2,
      generated_count: 2,
    })

    // BIT-IDENTICAL parent: no reactivation, no pointer move, no new calc row, and the row was not
    // even touched (`updated_at` unchanged).
    const after = (await recordRows(orgId, userIds[1]))[0]
    expect(after).toEqual(before)
    expect(after).toMatchObject({
      visibility_state: 'retired',
      visibility_reason: 'import_rollback',
      projection_owner: 'legacy_untracked',
      current_calculation_id: null,
    })
    expect(await calcRows(orgId, retiredRecordId)).toEqual([])
    expect(spies.applyScheduledAbsenceLegacy).toBe(0)

    // RESUME does not re-loop a terminal target. Driven through the recovery entrypoint against
    // THIS run id (an ordinary re-drive would mint a fresh generation instead, which is a different
    // question — see leg 6.10): the outstanding set is the LEFT JOIN's `o.id IS NULL`, and a
    // `'failed'` row is an outcome row, so target 2 is excluded exactly like the completed ones.
    const outcomesBefore = await outcomeRows(orgId)
    const resume = makeBoundary()
    const second = await resume.boundary.recoverScheduledRun({
      ...scheduledInput(orgId, userIds),
      runId: String(runs[0].run_id),
    })
    expect(second.kind).toBe('w4')
    if (second.kind !== 'w4') throw new Error('unreachable')
    expect(second.perUser).toEqual([])
    expect(await outcomeRows(orgId)).toEqual(outcomesBefore)
    expect(resume.spies.resolveScheduledCandidate).toBe(0)
  })

  it('leg 4e [GATING] — claim disposition: the contained-failed target is CANCELED with a NULL response (never sealed), the successful targets are completed, and the per-target transaction COMMITS', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    await retireParent(orgId, userIds[1])
    const { boundary } = makeBoundary()
    await boundary.executeScheduledRun(scheduledInput(orgId, userIds))

    const ops = await operationRows(orgId)
    expect(ops.length).toBe(3)
    const failed = ops.filter((o) => o.subject_user_id === userIds[1])
    expect(failed.length).toBe(1)
    // The legal terminal disposition for a claimed operation that produced no result. If this were
    // left `claimed`, the deferred `trg_aro_claimed_commit_guard` would raise `W4C0_CLAIMED_COMMIT`
    // at COMMIT and abort the batch — containment that does not contain.
    expect(failed[0].state).toBe('canceled')
    // SECOND ASSERTION, guarding the direction: a contained failure is NEVER sealed, so the
    // "seal ⇒ success snapshot" invariant survives rather than being strained.
    expect(failed[0].response_snapshot).toBeNull()
    expect(failed[0].resolved_calculation_id).toBeNull()
    expect(failed[0].resolved_record_id).toBeNull()

    for (const userId of [userIds[0], userIds[2]]) {
      const ok = ops.find((o) => o.subject_user_id === userId)
      expect(ok?.state).toBe('completed')
      expect(ok?.response_snapshot).toEqual({ inserted: true })
    }

    // The per-target transactions COMMITTED: the run reached `completed`, which requires every
    // outcome row to be durably visible to the finalize transaction.
    expect((await runRows(orgId))[0].state).toBe('completed')
    // And nothing is left in the intermediate state the commit guard forbids.
    expect(ops.filter((o) => o.state === 'claimed').length).toBe(0)
  })

  it('leg 6a — guard-409 (operator_retirement) is CONTAINED with ZERO reactivation, over a parent retired through the core\'s own reversal writer (a real row the pointer guard validates end to end)', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    // Generation 1 completes target 2 and takes W4 ownership of the day; the reversal writer then
    // retires it with `operator_retirement`. That order is forced by the schema, not chosen for
    // convenience: a `legacy_untracked` parent may not carry that reason at all.
    await retireParentOperatorRetirement(orgId, userIds[1], WORK_DATE)
    const before = (await recordRows(orgId, userIds[1]))[0]
    expect(before.visibility_reason).toBe('operator_retirement')

    // Generation 2 (a completed run is never resumed, so this mints fresh operation ids) drives all
    // three targets, with target 2 now operator-retired.
    const { boundary } = makeBoundary()
    const result = await boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')
    expect(result.perUser.find((p) => p.userId === userIds[1])).toEqual({
      userId: userIds[1],
      mode: 'failed',
      inserted: false,
    })
    expect(result.perUser.filter((p) => p.mode === 'executed').length).toBe(2)
    // ZERO REACTIVATION: without the guard the core's completed-path pointer UPDATE would flip this
    // parent back to `w4/active/active` unconditionally — it is reason-BLIND.
    expect((await recordRows(orgId, userIds[1]))[0]).toEqual(before)
    const outcomes = await outcomeRows(orgId)
    expect(outcomes.filter((o) => o.user_id === userIds[1] && o.terminal_outcome === 'failed').length).toBe(1)

    // VARIANT (a second case, not the primary): the parent is retired BETWEEN run creation and the
    // per-target transaction, rather than being retired before the run existed at all.
    const variantWorkDate = '2026-06-09'
    await retireParentOperatorRetirement(orgId, userIds[2], variantWorkDate)
    const variant = makeBoundary()
    const variantResult = await variant.boundary.executeScheduledRun(
      scheduledInput(orgId, [userIds[2]], variantWorkDate),
    )
    expect(variantResult.kind).toBe('w4')
    if (variantResult.kind !== 'w4') throw new Error('unreachable')
    expect(variantResult.perUser).toEqual([{ userId: userIds[2], mode: 'failed', inserted: false }])
  })

  it('leg 5a — a RETRYABLE serialization conflict (40001) is retried and SUCCEEDS; it is never converted to a failed outcome', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(2, { withShift: true })
    // Thrown from inside the authoritative branch on the FIRST attempt only. The registry's own
    // whole-transaction retry re-runs the body; the second attempt passes through.
    const fault: Fault = {
      userId: userIds[1],
      seam: 'resolveScheduledCandidate',
      make: (attempt) =>
        attempt === 1 ? Object.assign(new Error('serialization_failure'), { code: '40001' }) : null,
    }
    const { boundary, spies } = makeBoundary([fault])
    const result = await boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')
    expect(result.perUser).toEqual([
      { userId: userIds[0], mode: 'executed', inserted: true },
      { userId: userIds[1], mode: 'executed', inserted: true },
    ])
    // Non-vacuity: the fault really fired (the seam was entered twice for that user).
    expect(spies.resolveScheduledCandidate).toBeGreaterThanOrEqual(3)
    const outcomes = await outcomeRows(orgId)
    expect(outcomes.filter((o) => o.terminal_outcome === 'failed').length).toBe(0)
    expect((await runRows(orgId))[0]).toMatchObject({ state: 'completed', generated_count: 2 })
  })

  it('leg 5b — an UNTYPED error still ABORTS the batch, and the run stays resumable with the outstanding set intact', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    const fault: Fault = {
      userId: userIds[1],
      seam: 'resolveScheduledCandidate',
      make: () => new Error('W4C2_D3_UNTYPED_PROBE'),
    }
    const { boundary } = makeBoundary([fault])
    await expect(boundary.executeScheduledRun(scheduledInput(orgId, userIds))).rejects.toThrow(
      'W4C2_D3_UNTYPED_PROBE',
    )
    // Target 1 committed; target 2 aborted; target 3 was never attempted. The run is still running.
    const runs = await runRows(orgId)
    expect(runs.length).toBe(1)
    expect(runs[0].state).toBe('running')
    const outcomes = await outcomeRows(orgId)
    expect(outcomes.map((o) => o.user_id)).toEqual([userIds[0]])
    expect(outcomes[0].terminal_outcome).toBe('completed')
    // Nothing was burned terminally: the OUTSTANDING targets re-enter on a resume and complete.
    const resume = makeBoundary()
    const second = await resume.boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    expect(second.kind).toBe('w4')
    if (second.kind !== 'w4') throw new Error('unreachable')
    expect(second.perUser.map((p) => p.userId).sort()).toEqual([userIds[1], userIds[2]].sort())
    expect(second.perUser.every((p) => p.mode === 'executed')).toBe(true)
    expect((await runRows(orgId))[0]).toMatchObject({ state: 'completed', completed_user_count: 3 })
  })

  it('leg 5c — a NON-CONTAINED typed boundary error (the 500-class parent-unresolved family) ABORTS rather than becoming a failed outcome', async () => {
    // CONSTRUCTION NOTE, stated honestly: the NATURAL raise site for
    // `W4C2_AUTHORITATIVE_PARENT_UNRESOLVED` — our own placeholder INSERT and a racer's both leaving
    // no visible row under our own lock — is not constructible through the boundary (the class-11
    // advisory target lock prevents it one layer up). The error is therefore injected at an adapter
    // seam INSIDE the savepoint, as the exact class and code the boundary raises. What this proves is
    // the DISPOSITION (this class aborts, it is not contained), which is the property under test; it
    // does not prove the raise site is reachable, and does not claim to.
    const { AttendanceW4LiveScheduledBoundaryError } = await import(
      '../../src/attendance/w4c2-live-scheduled-boundary'
    )
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    const fault: Fault = {
      userId: userIds[1],
      seam: 'resolveScheduledCandidate',
      make: () => new AttendanceW4LiveScheduledBoundaryError('W4C2_AUTHORITATIVE_PARENT_UNRESOLVED', 500),
    }
    const { boundary } = makeBoundary([fault])
    await expect(boundary.executeScheduledRun(scheduledInput(orgId, userIds))).rejects.toMatchObject({
      code: 'W4C2_AUTHORITATIVE_PARENT_UNRESOLVED',
    })
    const outcomes = await outcomeRows(orgId)
    // NOT a failed outcome — that is the whole point of the split.
    expect(outcomes.filter((o) => o.terminal_outcome === 'failed').length).toBe(0)
    expect(outcomes.map((o) => o.user_id)).toEqual([userIds[0]])
    expect((await runRows(orgId))[0].state).toBe('running')
  })

  it('leg 8 — SKIP on a present, guard-admitted, not-retired parent: no core call, no placeholder, seal {inserted:false}, parent bit-identical', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(2, { withShift: true })
    // The ORDINARY case, not a race: a user who punched that day already has a legacy-ACTIVE parent
    // at run creation, because `'generate'` targets are not NOT-EXISTS-filtered there.
    const presentRecordId = uuid()
    await pool.query(
      `INSERT INTO attendance_records
         (id, org_id, user_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
          projection_owner, current_calculation_id, visibility_state, visibility_reason,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4::date, $5, now(), NULL, 480, 0, 0, 'normal', true, '{}'::jsonb,
               'legacy_untracked', NULL, 'active', 'active', now(), now())`,
      [presentRecordId, orgId, userIds[1], WORK_DATE, TZ],
    )
    const before = (await recordRows(orgId, userIds[1]))[0]

    const { boundary, spies } = makeBoundary()
    const result = await boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')
    expect(result.perUser).toEqual([
      { userId: userIds[0], mode: 'executed', inserted: true },
      // LEGACY PARITY: the legacy INSERT would have contributed `inserted=false` for exactly this
      // user, so `rows` / `generated_count` are unchanged by posture.
      { userId: userIds[1], mode: 'executed', inserted: false },
    ])
    expect(result.rows).toEqual([{ user_id: userIds[0] }])

    // BIT-IDENTICAL: no supersede, no pointer move, no placeholder, and no calc row at all — the
    // discriminator between SKIP and the supersede alternative.
    expect((await recordRows(orgId, userIds[1]))[0]).toEqual(before)
    expect(await calcRows(orgId, presentRecordId)).toEqual([])
    // The core's RECORD_NOT_FOUND (404) is unreachable for the legitimate dedup case.
    expect(await outcomeRows(orgId)).toEqual(
      [
        { user_id: userIds[0], terminal_outcome: 'completed', failure_reason_code: null },
        { user_id: userIds[1], terminal_outcome: 'completed', failure_reason_code: null },
      ].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
    )
    const ops = await operationRows(orgId)
    const skipped = ops.find((o) => o.subject_user_id === userIds[1])
    expect(skipped?.state).toBe('completed')
    expect(skipped?.response_snapshot).toEqual({ inserted: false })
    expect(skipped?.resolved_calculation_id).toBeNull()
    // A skip performs NO compute at all: the W2 resolver was entered once (for target 1 only).
    expect(spies.resolveScheduledCandidate).toBe(1)
    expect(spies.applyScheduledAbsenceLegacy).toBe(0)
  })

  it('leg 6.10 — SECOND GENERATION over a first-generation review placeholder: the guard ADMITS it and the re-attempt completes it (a deliberate, narrow divergence from legacy NOT-EXISTS parity)', async () => {
    // Generation 1: no shift ⇒ review ⇒ the parent is left as our own retired/review_placeholder.
    const { orgId, userIds } = await seedAuthoritativeOrg(1)
    const first = makeBoundary()
    await first.boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    const afterFirst = (await recordRows(orgId, userIds[0]))[0]
    expect(afterFirst).toMatchObject({ visibility_state: 'retired', visibility_reason: 'review_placeholder' })

    // Now give the user a shift so a re-attempt can actually resolve, and drive again. A completed
    // run is never resumed, so this mints a FRESH generation with fresh operation ids.
    await insertShiftAndAssignment(orgId, userIds[0])
    const second = makeBoundary()
    const result = await second.boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')
    expect(result.perUser).toEqual([{ userId: userIds[0], mode: 'executed', inserted: true }])
    // The placeholder is OUR artifact and the re-attempt completes it — legacy's `NOT EXISTS` would
    // have skipped (a row exists). Recorded as the deliberate divergence it is.
    const afterSecond = (await recordRows(orgId, userIds[0]))[0]
    expect(afterSecond).toMatchObject({
      id: afterFirst.id,
      projection_owner: 'w4',
      visibility_state: 'active',
      visibility_reason: 'active',
    })
    const runs = await runRows(orgId)
    expect(runs.map((r) => r.generation)).toEqual([1, 2])
  })

  it('leg 7a/7b — payloadFingerprint persists in input_provenance, and a re-drive of a completed target REPLAYS through the preflight with no second calc row', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(1, { withShift: true })
    const { boundary } = makeBoundary()
    await boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    const records = await recordRows(orgId, userIds[0])
    const calcsAfterFirst = await calcRows(orgId, String(records[0].id))
    expect(calcsAfterFirst.length).toBe(1)

    // 7a — the persisted provenance carries the embedded copy the core reads VERBATIM on a retry.
    const provenance = calcsAfterFirst[0].input_provenance as Record<string, unknown>
    expect(typeof provenance.payloadFingerprint).toBe('string')
    expect(provenance.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Recomputed here from the resolved command payload alone — the run id is the only value the
    // test has to read back, and it comes from the run row, not from the stored fingerprint.
    const runId = (await runRows(orgId))[0].run_id
    expect(provenance.payloadFingerprint).toBe(
      computeAuthoritativeScheduledPayloadFingerprintV1({
        scheduledRunId: String(runId),
        userId: userIds[0],
        workDate: WORK_DATE,
        expectedRunVersion: 1,
        scheduledAbsenceSource: 'cron_auto_absence',
      }),
    )
    expect(provenance.transport).toBe('scheduled_job')

    // 7b — a re-drive of the SAME (run, target) is served by the preflight replay: the completed run
    // is not resumed, so this drives the recovery entrypoint against the same run id.
    const replayBoundary = makeBoundary()
    const replayed = await replayBoundary.boundary.recoverScheduledRun({
      ...scheduledInput(orgId, userIds),
      runId: String(runId),
    })
    expect(replayed.kind).toBe('w4')
    if (replayed.kind !== 'w4') throw new Error('unreachable')
    // The completed target is NOT re-looped (the outstanding set is empty), so no second core call.
    expect(replayed.perUser).toEqual([])
    expect((await calcRows(orgId, String(records[0].id))).length).toBe(1)
  })

  it('leg 10 — SITE A probe routing: an authoritative org reaches the run-registry mode with ZERO legacy batch rows and no 503; legacy_projection_only still takes the batch arm; suspended still suspends', async () => {
    const authoritative = await seedAuthoritativeOrg(2, { withShift: true })
    const { boundary, spies } = makeBoundary()
    const result = await boundary.executeScheduledRun(
      scheduledInput(authoritative.orgId, authoritative.userIds),
    )
    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')
    expect(result.runId).not.toBeNull()
    // The probe never ran the legacy batch INSERT..SELECT, and never refused.
    expect(spies.applyScheduledAbsenceLegacy).toBe(0)

    // NEGATIVE CONTROL 1 — `legacy_projection_only` (an org with no rollout row at all) still takes
    // the probe's own legacy batch arm: ONE adapter call for the whole batch, `kind:'legacy'`.
    const legacyOrg = uuid()
    const legacyUsers = [uuid(), uuid()]
    for (const userId of legacyUsers) await insertActiveUser(userId, legacyOrg)
    await insertRolloutRow(legacyOrg, 'legacy')
    const legacy = makeBoundary()
    const legacyResult = await legacy.boundary.executeScheduledRun(scheduledInput(legacyOrg, legacyUsers))
    expect(legacyResult.kind).toBe('legacy')
    expect(legacy.spies.applyScheduledAbsenceLegacy).toBe(1)
    expect(legacy.spies.absenceUserIds.sort()).toEqual([...legacyUsers].sort())

    // NEGATIVE CONTROL 2 — `suspended` still suspends before any DML.
    const suspendedOrg = allow(uuid())
    const suspendedUser = uuid()
    await insertActiveUser(suspendedUser, suspendedOrg)
    await walkRolloutToSuspended(suspendedOrg)
    const suspended = makeBoundary()
    const suspendedResult = await suspended.boundary.executeScheduledRun(
      scheduledInput(suspendedOrg, [suspendedUser]),
    )
    expect(suspendedResult.kind).toBe('suspended')
    expect(suspended.spies.applyScheduledAbsenceLegacy).toBe(0)
  })

  it('leg 11 — outbox: ZERO per-target rows; finalize enqueues absence.generated with total = generatedCount; review_required fires iff the run\'s FROZEN review_count > 0', async () => {
    // (a) A run whose only review-ness is a `'generate'` target with a review_required CALCULATION
    //     outcome must NOT emit `attendance.work_date.review_required` — the finalize condition reads
    //     the run row's frozen `review_count`, which counts `'review'`-KIND targets only. This is
    //     today's shadow behaviour, unchanged by D3, disclosed rather than discovered later.
    const calcReview = await seedAuthoritativeOrg(1)
    const a = makeBoundary()
    await a.boundary.executeScheduledRun(scheduledInput(calcReview.orgId, calcReview.userIds))
    const aRows = await outboxRows(calcReview.orgId)
    expect(aRows.every((r) => r.identity_kind === 'scheduled_run')).toBe(true)
    expect(aRows.map((r) => r.event_kind)).toEqual(['attendance.absence.generated'])
    expect((aRows[0].payload as { total: number }).total).toBe(0)

    // (b) A run with a real `'review'`-KIND target DOES emit it, alongside the generated event whose
    //     total equals the fold's generated_count (completed-and-inserted only).
    const withReview = await seedAuthoritativeOrg(2, { withShift: true })
    const reviewUser = uuid()
    const b = makeBoundary()
    await b.boundary.executeScheduledRun({
      ...scheduledInput(withReview.orgId, withReview.userIds),
      reviewTargets: [{ userId: reviewUser, reasonCode: 'WORK_DATE_ATTRIBUTION_AMBIGUOUS' }],
    })
    const bRows = await outboxRows(withReview.orgId)
    expect(bRows.map((r) => r.event_kind).sort()).toEqual([
      'attendance.absence.generated',
      'attendance.work_date.review_required',
    ])
    const generated = bRows.find((r) => r.event_kind === 'attendance.absence.generated')
    const run = (await runRows(withReview.orgId))[0]
    expect((generated?.payload as { total: number }).total).toBe(Number(run.generated_count))
    expect(Number(run.generated_count)).toBe(2)
    // ZERO per-target rows on either run: every outbox row is run-scoped.
    expect(bRows.every((r) => r.scheduled_run_id !== null)).toBe(true)
    expect(bRows.length).toBe(2)
  })

  it('leg 12 — posture downgrade DURING the per-target loop: the per-target re-read is the branch SELECTOR, so the remaining targets take the legacy_compat path, no refusal appears anywhere, the run does not wedge, and it finalizes', async () => {
    // WHERE THIS SCENARIO IS ACTUALLY REACHABLE, measured rather than assumed. A demotion BETWEEN
    // boundary calls cannot produce a mixed run at all: `resumeAttendanceScheduledRunV1` refuses
    // with `W4C2_SCHEDULED_RUN_RESUME_POSTURE_MISMATCH` when the run's FROZEN posture differs from
    // the org's currently resolved one, so a demoted org can never resume its authoritative run
    // (verified by construction — that is the error that came back). The reachable form is a
    // demotion INSIDE one call's per-target loop, which the loop does not re-fence: only the
    // per-target posture re-read sees it. That is exactly the §6.7 default under test.
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    const demoteDuringTarget1: Fault = {
      userId: userIds[0],
      seam: 'resolveScheduledCandidate',
      make: () => {
        // Withdraw the exact-org allowlist entry while target 1 is mid-flight; target 1 finishes
        // authoritatively (its own posture read already happened), targets 2 and 3 do not.
        disallow(orgId)
        return null
      },
    }
    const { boundary, spies } = makeBoundary([demoteDuringTarget1])
    // DISCLOSED, PRE-EXISTING, AND NOT D3's: the FINALIZE transaction fences on posture too
    // (`W4C2_SCHEDULED_RUN_FINALIZATION_POSTURE_MISMATCH`), so a mid-run demotion surfaces there
    // after every per-target transaction has already committed. D3 changes nothing about that; it is
    // asserted rather than worked around so the leg cannot silently absorb a regression in it.
    await expect(boundary.executeScheduledRun(scheduledInput(orgId, userIds))).rejects.toMatchObject({
      code: 'W4C2_SCHEDULED_RUN_FINALIZATION_POSTURE_MISMATCH',
    })

    // MIXED RUN, read from committed state: each target is honest to the posture at its OWN write
    // time — target 1 authoritative, targets 2 and 3 through the existing `legacy_compat` downgrade
    // idiom — with NO refusal anywhere and no target left outstanding.
    expect(spies.applyScheduledAbsenceLegacy).toBe(2)
    expect(spies.absenceUserIds.sort()).toEqual([userIds[1], userIds[2]].sort())
    const outcomes = await outcomeRows(orgId)
    expect(outcomes.length).toBe(3)
    expect(outcomes.every((o) => o.terminal_outcome === 'completed')).toBe(true)
    expect((await recordRows(orgId, userIds[0]))[0].projection_owner).toBe('w4')
    expect((await recordRows(orgId, userIds[1]))[0]).toMatchObject({
      projection_owner: 'legacy_untracked',
      status: 'absent',
      visibility_state: 'active',
    })

    // NO WEDGE: restoring the posture lets the run finalize on the next drive, with zero targets
    // re-looped (they all already carry terminal outcomes).
    allow(orgId)
    const finalizer = makeBoundary()
    const finalized = await finalizer.boundary.recoverScheduledRun({
      ...scheduledInput(orgId, userIds),
      runId: String((await runRows(orgId))[0].run_id),
    })
    expect(finalized.kind).toBe('w4')
    if (finalized.kind !== 'w4') throw new Error('unreachable')
    expect(finalized.perUser).toEqual([])
    const runs = await runRows(orgId)
    expect(runs.length).toBe(1)
    expect(runs[0]).toMatchObject({ state: 'completed', completed_user_count: 3, generated_count: 3 })
  })

  it('leg 13 — recovery/resume re-entry: only OUTSTANDING targets re-enter the authoritative writer; an already-completed target is SKIPPED, not replayed', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    const fault: Fault = {
      userId: userIds[1],
      seam: 'resolveScheduledCandidate',
      make: () => new Error('W4C2_D3_KILL_AFTER_TARGET_1'),
    }
    const killed = makeBoundary([fault])
    await expect(killed.boundary.executeScheduledRun(scheduledInput(orgId, userIds))).rejects.toThrow()
    const runId = (await runRows(orgId))[0].run_id
    const calcsAfterKill = await calcRows(orgId)
    expect(calcsAfterKill.length).toBe(1)

    const recovered = makeBoundary()
    const result = await recovered.boundary.recoverScheduledRun({
      ...scheduledInput(orgId, userIds),
      runId: String(runId),
    })
    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')
    // The completed target does NOT reappear — the outstanding set is the LEFT JOIN's `o.id IS NULL`.
    expect(result.perUser.map((p) => p.userId).sort()).toEqual([userIds[1], userIds[2]].sort())
    expect(calcsAfterKill.length + 2).toBe((await calcRows(orgId)).length)
    expect((await runRows(orgId))[0]).toMatchObject({ state: 'completed', completed_user_count: 3 })
  })

  it('leg 14 — seal/outcome/fold coupling: every executed target has seal + outcome, a contained-failed target has an outcome and NO seal, and the fold recomputes from raw rows', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    await retireParent(orgId, userIds[2])
    const { boundary } = makeBoundary()
    await boundary.executeScheduledRun(scheduledInput(orgId, userIds))

    const ops = await operationRows(orgId)
    const outcomes = await outcomeRows(orgId)
    expect(outcomes.length).toBe(3)
    expect(ops.length).toBe(3)
    for (const outcome of outcomes) {
      const op = ops.find((o) => o.subject_user_id === outcome.user_id)
      if (outcome.terminal_outcome === 'failed') {
        expect(op?.state).toBe('canceled')
        expect(op?.response_snapshot).toBeNull()
      } else {
        expect(op?.state).toBe('completed')
        expect(op?.response_snapshot).not.toBeNull()
      }
    }

    // Recompute the fold's two counters from raw rows and compare with the frozen run row.
    const recomputed = await pool.query(
      `SELECT count(*) FILTER (WHERE o.terminal_outcome = 'completed')::int AS completed,
              count(*) FILTER (WHERE o.terminal_outcome = 'completed'
                               AND op.response_snapshot ->> 'inserted' = 'true')::int AS generated
         FROM attendance_scheduled_run_target_outcomes o
         JOIN attendance_scheduled_run_targets t ON t.id = o.target_id AND t.org_id = o.org_id
         LEFT JOIN attendance_result_operations op
                ON op.operation_id = t.operation_id AND op.org_id = t.org_id
        WHERE o.org_id = $1`,
      [orgId],
    )
    const run = (await runRows(orgId))[0]
    expect(Number(run.completed_user_count)).toBe(recomputed.rows[0].completed)
    expect(Number(run.generated_count)).toBe(recomputed.rows[0].generated)
    expect(Number(run.generated_count)).toBe(2)
  })

  it('leg 15 — compat-fingerprint byte identity: the preimage builder over a legacy-active-shaped locked row equals a canonical recompute (direct leg; the supersede path is dormant under the SKIP default)', async () => {
    // Under the shipped §6.2 SKIP default the scheduled branch never reaches the core with a
    // legacy-ACTIVE parent, so the compatibility fingerprint is dormant on this path. The producer
    // is pinned DIRECTLY so the fork's other side has no latent landmine: the boundary hashes the
    // SAME normalized bytes it stores, via the canonical import/rollback producer.
    const firstInAt = new Date('2026-06-08T01:00:00.000Z')
    const projection = {
      status: 'normal',
      firstInAt: firstInAt.toISOString(),
      lastOutAt: null,
      workMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
    }
    const canonical = computeAttendanceImportRollbackPreimageFingerprintV1({
      projection,
      projectionOwner: 'legacy_untracked',
      currentCalculationId: null,
      visibilityState: 'active',
      visibilityReason: 'active',
    })
    expect(canonical).toMatch(/^[0-9a-f]{64}$/)
    // A raw `timestamptz` (Date) normalized to ISO produces the identical digest — the "hash what
    // you store" property. A Date fed through unnormalized would not.
    const viaDate = computeAttendanceImportRollbackPreimageFingerprintV1({
      projection: { ...projection, firstInAt: new Date(firstInAt).toISOString() },
      projectionOwner: 'legacy_untracked',
      currentCalculationId: null,
      visibilityState: 'active',
      visibilityReason: 'active',
    })
    expect(viaDate).toBe(canonical)
    // Discriminating: a different visibility reason moves the digest.
    expect(
      computeAttendanceImportRollbackPreimageFingerprintV1({
        projection,
        projectionOwner: 'legacy_untracked',
        currentCalculationId: null,
        visibilityState: 'retired',
        visibilityReason: 'review_placeholder',
      }),
    ).not.toBe(canonical)
  })

  it('leg 4b — rollback completeness: a refusal forced AFTER the placeholder INSERT leaves NO attendance_records row behind, and the failed outcome does exist', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    // Target 2's parent is ABSENT, so the seam creates the placeholder INSIDE the savepoint; the
    // core-class refusal is forced AFTER it, at the frozen-context seam. Injected as the exact class
    // the D1 core raises, so the containment path taken is the real one.
    const { AttendanceW4AuthoritativeCalculationError } = await import(
      '../../src/attendance/w4c2-authoritative-calculation-core'
    )
    const fault: Fault = {
      userId: userIds[1],
      seam: 'buildShadowFrozenContext',
      make: () =>
        new AttendanceW4AuthoritativeCalculationError('ATTENDANCE_W4_AUTH_CALC_PREIMAGE_INVALID', 422),
    }
    const { boundary } = makeBoundary([fault])
    const result = await boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')
    expect(result.perUser.find((p) => p.userId === userIds[1])?.mode).toBe('failed')

    // THE ASSERTION: the placeholder the seam inserted was rolled back with the savepoint. An
    // orphan `review_placeholder` parent for a target that produced nothing is exactly what
    // removing `ROLLBACK TO SAVEPOINT` leaves behind.
    expect(await recordRows(orgId, userIds[1])).toEqual([])
    const outcomes = await outcomeRows(orgId)
    expect(outcomes.find((o) => o.user_id === userIds[1])).toEqual({
      user_id: userIds[1],
      terminal_outcome: 'failed',
      failure_reason_code: 'ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED',
    })
    // And the batch continued.
    expect(outcomes.filter((o) => o.terminal_outcome === 'completed').length).toBe(2)
  })

  it('leg 4c — CORE-error arm: a real AttendanceW4AuthoritativeCalculationError raised BY THE CORE ITSELF (REPLAY_CONFLICT via a decoy calc row) is contained, proving the containment is class-general and not guard-specific', async () => {
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    // Two-phase fixture. Phase 1: drive target 1 only, so a durable run exists whose target 2 row
    // carries a committed `operation_id` we can read.
    const fault: Fault = {
      userId: userIds[1],
      seam: 'resolveScheduledCandidate',
      make: (attempt) => (attempt === 1 ? new Error('W4C2_D3_PHASE_1_STOP') : null),
    }
    const phase1 = makeBoundary([fault])
    await expect(phase1.boundary.executeScheduledRun(scheduledInput(orgId, userIds))).rejects.toThrow(
      'W4C2_D3_PHASE_1_STOP',
    )
    const runId = String((await runRows(orgId))[0].run_id)
    const target = await pool.query(
      `SELECT operation_id::text AS operation_id FROM attendance_scheduled_run_targets
        WHERE org_id = $1 AND run_id = $2::uuid AND user_id = $3 AND target_kind = 'generate'`,
      [orgId, runId, userIds[1]],
    )
    expect(target.rows.length).toBe(1)
    const operationId = String(target.rows[0].operation_id)

    // Phase 2: plant a DECOY calculation row on a parent for target 2 keyed by
    // (org, entrypoint='scheduled', operation_id) whose `input_provenance` lacks
    // `payloadFingerprint`. The core's own `retryReplayLookup` finds it, the fingerprints mismatch,
    // and it fails REPLAY_CONFLICT (409) BEFORE any write — a refusal the CORE raises, not the guard.
    const decoyRecordId = uuid()
    await pool.query(
      `INSERT INTO attendance_records
         (id, org_id, user_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes,
          status, is_workday, meta, projection_owner, current_calculation_id, visibility_state,
          visibility_reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4::date, $5, 0, 0, 0, 'normal', true, '{}'::jsonb,
               'legacy_untracked', NULL, 'retired', 'review_placeholder', now(), now())`,
      [decoyRecordId, orgId, userIds[1], WORK_DATE, TZ],
    )
    await pool.query(
      `INSERT INTO attendance_record_calculations
         (id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
          engine_version, snapshot_schema_version, operation_id,
          semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
          attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
          approved_facts_snapshot, manual_override_snapshot, input_provenance, merge_policy,
          calculation_tier, outcome, outcome_reason_code, projection_effect, expected_segment_count,
          actor_id, correlation_id, created_at)
       VALUES ($1, $2, $3::uuid, 1, 'calculation', 'authoritative', 'scheduled',
               'w4c2-d3-decoy', 1, $4::uuid,
               $5, $5, NULL,
               '{"posture":"unsupported","sourceSchemaVersion":null,"reason":"unresolved","sourceFingerprint":null}'::jsonb,
               NULL, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL,
               '{"transport":"scheduled_job"}'::jsonb, 'append',
               'segment_authoritative', 'review_required', 'input_schema_invalid', 'none', 0,
               'w4c2-d3-actor', 'w4c2-d3-decoy', now())`,
      [uuid(), orgId, decoyRecordId, operationId, 'a'.repeat(64)],
    )

    const phase2 = makeBoundary()
    const result = await phase2.boundary.recoverScheduledRun({
      ...scheduledInput(orgId, userIds),
      runId,
    })
    expect(result.kind).toBe('w4')
    if (result.kind !== 'w4') throw new Error('unreachable')
    // Target 2 was refused BY THE CORE and contained; target 3 still completed.
    expect(result.perUser.find((p) => p.userId === userIds[1])?.mode).toBe('failed')
    expect(result.perUser.find((p) => p.userId === userIds[2])?.mode).toBe('executed')
    const outcomes = await outcomeRows(orgId)
    expect(outcomes.find((o) => o.user_id === userIds[1])).toMatchObject({
      terminal_outcome: 'failed',
      failure_reason_code: 'ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED',
    })
    // The decoy row is the ONLY calculation on that parent — the refused attempt wrote nothing.
    expect((await calcRows(orgId, decoyRecordId)).length).toBe(1)
    expect((await runRows(orgId))[0].state).toBe('completed')
  })

  it('leg 4d — savepoint BALANCE (a statement-stream assertion, NOT an outcome assertion): the branch opens exactly as many savepoints as it releases, with ROLLBACK TO observed on the contained path', async () => {
    // STATED WEAKNESS, per the brief: this proves the RELEASE is issued, not that omitting it causes
    // harm. D2 already measured that 200 un-released savepoints complete fine and that the counters
    // which would expose an overflow do not exist on the Postgres 14 CI pins; and structurally each
    // target runs in its OWN transaction with one savepoint, committed right after the outcome
    // INSERT, so savepoints cannot stack across targets here at all.
    const { orgId, userIds } = await seedAuthoritativeOrg(3, { withShift: true })
    await retireParent(orgId, userIds[1])
    const { boundary, spies } = makeBoundary()
    await boundary.executeScheduledRun(scheduledInput(orgId, userIds))
    // SCOPED BY NAME to D3's OWN savepoint, for two separately-measured reasons.
    //
    // (1) A bare `^SAVEPOINT ` count would be wrong, not merely noisy: `assertConnectionIsIdleV1`
    //     issues `SAVEPOINT w4c5_idle_probe` on every connection acquisition and deliberately does
    //     NOT release it on the path it expects (the probe is meant to FAIL on an idle connection),
    //     so an unscoped balance assertion is unsatisfiable by construction and would have to be
    //     weakened until it proved nothing.
    //
    // (2) The CORE's own savepoint (`attendance_w4_auth_calc_op`) is deliberately NOT asserted
    //     here, and including it would be a latent FALSE pin. Its catch path rethrows anything that
    //     is not a `uq_arc_operation` unique violation WITHOUT rolling back or releasing
    //     (`w4c2-authoritative-calculation-core.ts`: `if (!isUniqueViolationOnConstraintV1(...))
    //     throw error`) — correct, because the caller's own `ROLLBACK TO` subsumes it, but it does
    //     leave opened > released for that name whenever the core refuses with e.g.
    //     COMPLETED_SHAPE_INVALID / EXPECTED_COUNT_INVALID / PREIMAGE_INVALID. THIS fixture never
    //     drives that arm (its refusal happens in the seam, before the core is called), so an
    //     assertion over the core's name would pass today and red the moment a future leg drove a
    //     core-internal refusal — and the obvious "fix" would be to weaken it. The core's savepoint
    //     balance is the core's own property, pinned in the core's own suite.
    const NAME = 'attendance_w4c2_scheduled_authoritative'
    const opened = spies.statements.filter((s) => s === `SAVEPOINT ${NAME}`).length
    const released = spies.statements.filter((s) => s === `RELEASE SAVEPOINT ${NAME}`).length
    expect(opened).toBeGreaterThan(0)
    expect(released).toBe(opened)
    const rolledBack = spies.statements.filter((s) => s === `ROLLBACK TO SAVEPOINT ${NAME}`).length
    // The contained target's rollback really happened (otherwise this leg would be a balance
    // assertion over the success path only).
    expect(rolledBack).toBe(1)
  })
})
