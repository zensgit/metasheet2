/**
 * W7-2 (#4556) — the `group_shadow` DUAL-RUN, produced-row legs (real DB).
 *
 * Authority: #4556 comments 5293034619 + 5293478713; design lock §4.2
 * (`group_shadow`: the legacy path remains the authoritative producer byte
 * for byte; alongside it the W7 resolver produces a group-derived frozen
 * context and a shadow calculation, recorded through the existing shadow
 * machinery), §5 item 1 (per-target failure), red lines W7-R3 / W7-R8.
 *
 * WHAT THIS DRIVES: the PRODUCTION boundary factory
 * (`createAttendanceLiveScheduledBoundaryV1`) over real PostgreSQL with the
 * plugin's REAL scheduled adapters and the REAL core issuance seam — the same
 * offline-boundary pattern as the landed D3 suite, with the seam adapter
 * being `issueAttendanceFrozenContextV1` itself rather than a stub. The
 * scheduled entrypoint exercises BOTH recording sites of its posture pair:
 * P3b (W4-shadow org) and P3a (W4-authoritative org).
 *
 * These are the PRODUCED-ROW twins of the seeded legs in
 * `attendance-w7-2-compare-window-status.db.test.ts` (brief §5.0): every W7
 * comparison row asserted here was written by the production recorder off a
 * real run, never seeded.
 *
 * NAMED NON-COVERAGE (reported, not hidden): the LIVE producer pair (P1/P2)
 * shares `issueThroughW7Seam` + `recordW7GroupShadowComparisonV1` with the
 * scheduled pair exercised here, and its SERVED-byte parity under the
 * shadow-compare postures is carried by the extended golden harness
 * (`attendance-w7-1b-legacy-arm-golden.db.test.ts`, W7-2 T-A1 legs) — but no
 * leg in this suite drives a live punch end-to-end through P1/P2 recording.
 *
 * Shared-DB discipline: file-namespaced random UUIDs; the suite deletes only
 * its own rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import {
  createAttendanceLiveScheduledBoundaryV1,
  type AttendanceW4LiveScheduledBoundaryV1,
} from '../../src/attendance/w4c2-live-scheduled-boundary'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import { issueAttendanceFrozenContextV1 } from '../../src/attendance/w7-resolver/w7-frozen-context-issuance-seam'
import {
  readAttendanceW7CompareWindowStatusV1,
  ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1,
} from '../../src/attendance/w7-compare-window-status'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const TZ = 'Asia/Shanghai'
const WORK_DATE = '2026-05-04'
const WINDOW = { from: '2026-05-01', to: '2026-05-31' }
const W4_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const W7_ENV = 'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'
const POSTURE_TABLE = 'attendance_calculation_context_source_state'
const MARKER = ATTENDANCE_W7_GROUP_SHADOW_PROVENANCE_MARKER_V1

const requireCjs = createRequire(import.meta.url)

type ScheduledAdapters = {
  generateAbsenceRecords: (
    trx: unknown,
    orgId: string,
    workDate: string,
    timezone: string,
    userIds: readonly string[],
  ) => Promise<unknown[]>
  resolveW4ScheduledCandidateInTransactionV1: (trx: unknown, args: unknown) => Promise<unknown>
  buildW4ShadowFrozenContextV1: (trx: unknown, args: unknown) => Promise<Record<string, unknown> | null>
}

describeDb('W7-2 — group_shadow dual-run: produced comparison rows (real boundary, real seam, real DB)', () => {
  let pool: Pool
  let adapters: ScheduledAdapters
  let priorW4: string | undefined
  let priorW7: string | undefined

  // W4-shadow org (P3b): one fully-effective group user + one membership-gap user.
  const shadowOrg = randomUUID()
  const groupUser = randomUUID()
  const gapUser = randomUUID()
  const shadowShift = randomUUID()
  const shadowGroupId = randomUUID()
  // W4-authoritative org (P3a): one fully-effective group user.
  const authOrg = randomUUID()
  const authUser = randomUUID()
  const authShift = randomUUID()
  const authGroupId = randomUUID()
  // Baseline org: same W4 shadow shape, NO W7 posture — the dual-run must not engage.
  const baselineOrg = randomUUID()
  const baselineUser = randomUUID()
  const baselineShift = randomUUID()

  const allOrgs = () => [shadowOrg, authOrg, baselineOrg]
  const allUsers = () => [groupUser, gapUser, authUser, baselineUser]

  // ---- fixture helpers (lifted from the landed 1b/D3 suites) ---------------

  async function insertShift(orgId: string, shiftId: string, name: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight, working_days,
          late_grace_minutes, early_grace_minutes, rounding_minutes, flex_mode)
       VALUES ($1, $2, $3, $4, '09:00', '18:00', false, '[0,1,2,3,4,5,6]'::jsonb, 5, 7, 15, 'strict')`,
      [shiftId, orgId, name, TZ],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time, start_day_offset, end_day_offset)
       VALUES ($1, $2, $3, 0, '09:00', '18:00', 0, 0)`,
      [randomUUID(), orgId, shiftId],
    )
  }

  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W7-2 dualrun fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w7-2.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }

  async function seedEffectiveGroup(orgId: string, userId: string, shiftId: string, gid: string) {
    const producerKeyLib = requireCjs(
      '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
    ) as { buildAttendanceGroupFixedScheduleProducerKey: (input: unknown) => string }
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, attendance_type, timezone)
       VALUES ($1, $2, $3, 'fixed_shift', $4)`,
      [gid, orgId, `w7-2 group ${gid}`, TZ],
    )
    await pool.query(
      `INSERT INTO attendance_group_fixed_schedule_configs
         (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 1, 'w7-2-fixture')`,
      [orgId, gid, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)`,
      [orgId, gid, userId],
    )
    const producerKey = producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey({
      groupId: gid,
      shiftId,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    })
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active,
          producer_type, producer_ref_id, producer_key, producer_run_id, publish_status)
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', true,
               'attendance_group_fixed_schedule', $4, $5, $6, 'published')`,
      [orgId, userId, shiftId, gid, producerKey, randomUUID()],
    )
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships
         (org_id, user_id, group_id, effective_from, effective_to,
          assigned_by, assigned_reason, assigned_correlation_id)
       VALUES ($1, $2, $3, '2026-01-01', NULL, 'w7-2-fixture', 'seed', $4)`,
      [orgId, userId, gid, `w7-2-corr-${gid}`],
    )
  }

  /** A user the SCHEDULED resolver can resolve but whose W7 group resolution
   *  fail-closes: published legacy assignment, NO calc-group membership. */
  async function seedGapAssignment(orgId: string, userId: string, shiftId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, slot_index)
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', true, 'published', 1)`,
      [orgId, userId, shiftId],
    )
  }

  async function insertRolloutRow(orgId: string, target: 'shadow' | 'authoritative'): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'w7-2-dualrun', 'TEST_FIXTURE', 'w7-2-actor', 1, NULL)`,
      [orgId],
    )
    const edges =
      target === 'shadow'
        ? ([['shadow', 'legacy', 2]] as const)
        : ([['shadow', 'legacy', 2], ['eligible', 'shadow', 3], ['authoritative', 'eligible', 4]] as const)
    for (const [state, prior, version] of edges) {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1`,
        [orgId, state, prior, version],
      )
    }
  }

  const setW7Posture = (orgId: string, state: string) =>
    pool.query(
      `INSERT INTO ${POSTURE_TABLE} (org_id, state, scope) VALUES ($1, $2, 'synthetic_staging')`,
      [orgId.toLowerCase(), state],
    )

  // ---- the REAL boundary with the REAL seam --------------------------------

  function makeBoundary(): AttendanceW4LiveScheduledBoundaryV1 {
    const effectivenessLib = requireCjs(
      '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs',
    ) as { deriveAttendanceGroupFixedScheduleEffectiveness: unknown }
    const producerKeyLib = requireCjs(
      '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
    ) as { buildAttendanceGroupFixedScheduleProducerKey: unknown }
    const unreached = (name: string) => async () => {
      throw new Error(`W7_2_DUALRUN_LIVE_STUB_${name}_MUST_NOT_BE_REACHED`)
    }
    const legacyAdapters = {
      applyLivePunchLegacy: unreached('applyLivePunchLegacy') as never,
      insertLivePunchEvent: unreached('insertLivePunchEvent') as never,
      deriveLivePunchWorkDateResolution: unreached('deriveLivePunchWorkDateResolution') as never,
      resolveLiveCandidate: unreached('resolveLiveCandidate') as never,
      applyScheduledAbsenceLegacy: (trx: unknown, args: { orgId: string; workDate: string; timezone: string; userIds: readonly string[] }) =>
        adapters.generateAbsenceRecords(trx, args.orgId, args.workDate, args.timezone, args.userIds),
      resolveScheduledCandidate: (trx: unknown, args: unknown) =>
        adapters.resolveW4ScheduledCandidateInTransactionV1(trx, args),
      buildShadowFrozenContext: (trx: unknown, args: unknown) =>
        adapters.buildW4ShadowFrozenContextV1(trx, args),
      // THE REAL SEAM — not a stub. Deps mirror the production wrapper in
      // `plugins/plugin-attendance/index.cjs` (`issueW4FrozenContextViaW7SeamV1`):
      // the same pure FSER derivation, the same canonical producer-key builder,
      // the same legacy-builder thunk over the caller's plugin-shaped client.
      // `loadOrgRuleFacts` reproduces the production wrapper's DEFAULT_RULE
      // fallback for an org with no attendance-rule row (these fixture orgs
      // seed none) — the same 30/60 thresholds the legacy builder froze into
      // the golden vectors for rule-less orgs, asserted below by the V1/V2
      // context parity leg rather than assumed.
      issueFrozenContext: (pluginTrx: { query: (s: string, p?: unknown[]) => Promise<unknown[]> }, args: Record<string, unknown>) => {
        const coreTrx = {
          query: async (sqlText: string, params?: unknown[]) => ({
            rows: await pluginTrx.query(sqlText, params ?? []),
          }),
        }
        return issueAttendanceFrozenContextV1(
          coreTrx as never,
          {
            deriveFixedScheduleEffectiveness:
              effectivenessLib.deriveAttendanceGroupFixedScheduleEffectiveness,
            buildFixedScheduleProducerKey: producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey,
            loadOrgRuleFacts: async () => ({
              severeLateThresholdMinutes: 30,
              absenceLateThresholdMinutes: 60,
            }),
            buildLegacyFrozenContext: (legacyArgs: unknown) =>
              adapters.buildW4ShadowFrozenContextV1(pluginTrx, legacyArgs),
          } as never,
          args as never,
        )
      },
    }
    return createAttendanceLiveScheduledBoundaryV1({
      acquireConnection: async () => {
        const client = await pool.connect()
        return {
          client: client as unknown as AttendanceW4TransactionClientV1,
          release: () => client.release(),
        }
      },
      legacyAdapters: legacyAdapters as never,
    })
  }

  const scheduledInput = (orgId: string, userIds: readonly string[]) => ({
    orgId,
    workDate: WORK_DATE,
    timezone: TZ,
    targetUserIds: [...userIds],
    reviewTargets: [] as ReadonlyArray<{ userId: string; reasonCode: string }>,
    initiator: 'cron' as const,
    adminActorId: null,
  })

  // ---- readers -------------------------------------------------------------

  const calcRowsFor = async (orgId: string, userId: string) =>
    (
      await pool.query(
        `SELECT c.id::text AS id, c.version, c.mode, c.entrypoint, c.operation_id::text AS operation_id,
                c.outcome, c.outcome_reason_code, c.projection_effect, c.shadow_diff_code,
                c.calculation_tier,
                c.context_snapshot, (c.context_snapshot ->> 'selector') AS selector,
                (c.input_provenance -> '${MARKER}') AS w7_marker,
                r.id::text AS record_id, r.current_calculation_id::text AS current_calculation_id,
                r.projection_owner
           FROM attendance_record_calculations c
           JOIN attendance_records r ON r.id = c.attendance_record_id AND r.org_id = c.org_id
          WHERE c.org_id = $1 AND r.user_id = $2 AND r.work_date = $3::date
          ORDER BY c.version`,
        [orgId, userId, WORK_DATE],
      )
    ).rows

  const trx = () => ({
    query: async (sqlText: string, params?: unknown[]) => ({
      rows: (await pool.query(sqlText, params)).rows,
    }),
  })

  beforeAll(async () => {
    if (!dbUrl) throw new Error('W7-2 dualrun suite needs DATABASE_URL')
    pool = new Pool({ connectionString: dbUrl })
    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW4c2ScheduledAdaptersForTests: ScheduledAdapters
    }
    adapters = plugin.__attendanceW4c2ScheduledAdaptersForTests
    expect(typeof adapters?.generateAbsenceRecords).toBe('function')

    priorW4 = process.env[W4_ENV]
    priorW7 = process.env[W7_ENV]
    process.env[W4_ENV] = allOrgs().join(',')
    process.env[W7_ENV] = [shadowOrg, authOrg].map((o) => o.toLowerCase()).join(',')

    // shadowOrg: W4 shadow + W7 group_shadow; group user + gap user.
    await insertShift(shadowOrg, shadowShift, 'w7-2 shadow-org shift')
    await insertActiveUser(groupUser, shadowOrg)
    await insertActiveUser(gapUser, shadowOrg)
    await seedEffectiveGroup(shadowOrg, groupUser, shadowShift, shadowGroupId)
    await seedGapAssignment(shadowOrg, gapUser, shadowShift)
    await insertRolloutRow(shadowOrg, 'shadow')
    await setW7Posture(shadowOrg, 'group_shadow')

    // authOrg: W4 authoritative + W7 group_shadow; group user.
    await insertShift(authOrg, authShift, 'w7-2 auth-org shift')
    await insertActiveUser(authUser, authOrg)
    await seedEffectiveGroup(authOrg, authUser, authShift, authGroupId)
    await insertRolloutRow(authOrg, 'authoritative')
    await setW7Posture(authOrg, 'group_shadow')

    // baselineOrg: W4 shadow, NO W7 posture row.
    await insertShift(baselineOrg, baselineShift, 'w7-2 baseline shift')
    await insertActiveUser(baselineUser, baselineOrg)
    await seedGapAssignment(baselineOrg, baselineUser, baselineShift)
    await insertRolloutRow(baselineOrg, 'shadow')

    // ---- the three PRODUCING runs, one per org ----
    const boundary = makeBoundary()
    await boundary.executeScheduledRun(scheduledInput(shadowOrg, [groupUser, gapUser]))
    await boundary.executeScheduledRun(scheduledInput(authOrg, [authUser]))
    await boundary.executeScheduledRun(scheduledInput(baselineOrg, [baselineUser]))
  }, 180_000)

  afterAll(async () => {
    const orgs = allOrgs()
    for (const table of [
      'attendance_record_segments',
      'attendance_record_calculations',
      'attendance_result_event_outbox',
      'attendance_scheduled_run_target_outcomes',
      'attendance_scheduled_run_targets',
      'attendance_result_operations',
      'attendance_scheduled_runs',
      'attendance_records',
      'attendance_calculation_group_memberships',
      'attendance_shift_assignments',
      'attendance_group_fixed_schedule_configs',
      'attendance_group_members',
      'attendance_groups',
      'attendance_shift_segments',
      'attendance_shifts',
      'attendance_calculation_rollout_state',
    ]) {
      await pool?.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [orgs]).catch(() => undefined)
    }
    await pool
      ?.query(`DELETE FROM ${POSTURE_TABLE} WHERE org_id = ANY($1::text[])`, [orgs.map((o) => o.toLowerCase())])
      .catch(() => undefined)
    await pool?.query(`DELETE FROM user_orgs WHERE org_id = ANY($1::text[])`, [allOrgs()]).catch(() => undefined)
    await pool?.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [allUsers()]).catch(() => undefined)
    await pool?.end()
    if (priorW4 === undefined) delete process.env[W4_ENV]
    else process.env[W4_ENV] = priorW4
    if (priorW7 === undefined) delete process.env[W7_ENV]
    else process.env[W7_ENV] = priorW7
  }, 60_000)

  // -------------------------------------------------------------------------
  // T-A2 + T-D1 (produced): the dual-run wrote BOTH rows for one target.
  // -------------------------------------------------------------------------
  it('T-A2/T-D1 (produced, P3b): one scheduled operation wrote the W4 shadow row AND the W7 comparison row — same operation, adjacent versions, opposite selectors', async () => {
    const rows = await calcRowsFor(shadowOrg, groupUser)
    const w4Rows = rows.filter((r) => r.w7_marker === null && r.mode === 'shadow')
    const w7Rows = rows.filter((r) => r.w7_marker !== null)
    expect(w4Rows.length, 'exactly one W4 shadow row').toBe(1)
    expect(w7Rows.length, 'exactly one W7 comparison row').toBe(1)
    const w4 = w4Rows[0]
    const w7 = w7Rows[0]
    // Same producing operation, same entrypoint — the dedup-index split is
    // what makes this pair persistable at all.
    expect(w7.operation_id).toBe(w4.operation_id)
    expect(w4.entrypoint).toBe('scheduled')
    expect(w7.entrypoint).toBe('scheduled')
    expect(Number(w7.version)).toBe(Number(w4.version) + 1)
    // The selector discriminator, produced: legacy vs group_effective.
    expect(w4.selector).toBe('legacy')
    expect(w7.selector).toBe('group_effective')
    expect(w7.mode).toBe('shadow')
    expect(w7.calculation_tier).toBe('legacy_shadow')
    // Marker shape: schemaVersion + null shadowReason (the group arm RESOLVED).
    expect(w7.w7_marker).toEqual({ schemaVersion: 1, shadowReason: null })
  })

  it('context parity (produced): the W7 context differs from the W4 twin ONLY in the three discriminants, and both calculations agree', async () => {
    const rows = await calcRowsFor(shadowOrg, groupUser)
    const w4 = rows.find((r) => r.w7_marker === null && r.mode === 'shadow')!
    const w7 = rows.find((r) => r.w7_marker !== null)!
    const v1 = w4.context_snapshot as Record<string, unknown>
    const v2 = w7.context_snapshot as Record<string, unknown>
    expect(v1.schemaVersion).toBe(1)
    expect(v2.schemaVersion).toBe(2)
    expect(v1.selector).toBe('legacy')
    expect(v2.selector).toBe('group_effective')
    expect(v1.calculationGroupId).toBeNull()
    expect(v2.calculationGroupId).toBe(shadowGroupId)
    // Every OTHER member equal — same shift policy through two resolution paths.
    for (const key of [
      'orgId', 'userId', 'workDate', 'timezone', 'shiftId', 'isWorkday', 'holidayKind',
      'roundingMinutes', 'severeLateThresholdMinutes', 'absenceLateThresholdMinutes', 'segments',
    ]) {
      expect(v2[key], `context member ${key}`).toEqual(v1[key])
    }
    // Same inputs, same engine => same outcome and the SAME diff code (the W7
    // comparison and the W4 comparison used the same served projection).
    expect(w7.outcome).toBe(w4.outcome)
    expect(w7.shadow_diff_code).toBe(w4.shadow_diff_code)
  })

  // -------------------------------------------------------------------------
  // T-A5 (produced): W7-R8 — shadow by construction, pointer untouched.
  // -------------------------------------------------------------------------
  it('T-A5 (produced): the W7 row is projection_effect=none and the parent pointer is untouched on BOTH org postures', async () => {
    const shadowRows = await calcRowsFor(shadowOrg, groupUser)
    const w7Shadow = shadowRows.find((r) => r.w7_marker !== null)!
    expect(w7Shadow.projection_effect).toBe('none')
    // W4-shadow org: the parent never gains a pointer at all.
    expect(w7Shadow.current_calculation_id).toBeNull()
    expect(w7Shadow.projection_owner).toBe('legacy_untracked')

    const authRows = await calcRowsFor(authOrg, authUser)
    const w7Auth = authRows.find((r) => r.w7_marker !== null)
    const served = authRows.find((r) => r.mode === 'authoritative')
    expect(w7Auth, 'P3a must record a comparison row too').toBeTruthy()
    expect(served, 'the authoritative served row must exist').toBeTruthy()
    expect(w7Auth!.projection_effect).toBe('none')
    // The pointer names the SERVED authoritative calculation, never the W7 row.
    if (served!.outcome === 'completed') {
      expect(w7Auth!.current_calculation_id).toBe(served!.id)
    } else {
      expect(w7Auth!.current_calculation_id).toBeNull()
    }
    // DB-level backstop: `chk_arc_shadow_effect` REJECTS a shadow row with a
    // projection effect (probed in a rolled-back transaction).
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      let code: string | null = null
      try {
        await client.query(
          `UPDATE attendance_record_calculations SET projection_effect = 'set_active' WHERE id = $1::uuid`,
          [w7Shadow.id],
        )
      } catch (error) {
        code = (error as { code?: string }).code ?? null
      }
      // Either the immutability trigger (raise) or the CHECK rejects — both
      // fail closed; the row can never become served by mutation.
      expect(code, 'mutating a W7 comparison row into a served one must be rejected').not.toBeNull()
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  // -------------------------------------------------------------------------
  // T-E1/T-E2/T-E3 (produced): the fail-close half on the real batch path.
  // -------------------------------------------------------------------------
  it('T-E1/T-E3 (produced): the membership-gap user’s comparison records the fail-close reason with a NULL context — never a substituted legacy context', async () => {
    const rows = await calcRowsFor(shadowOrg, gapUser)
    const w4 = rows.find((r) => r.w7_marker === null && r.mode === 'shadow')
    const w7 = rows.find((r) => r.w7_marker !== null)
    expect(w4, 'the served-path W4 shadow row exists').toBeTruthy()
    expect(w7, 'the W7 fail-close record exists').toBeTruthy()
    // T-E1: the reason is carried, closed and exact.
    expect(w7!.w7_marker).toEqual({ schemaVersion: 1, shadowReason: 'membership-absent' })
    expect(w7!.outcome).toBe('review_required')
    expect(w7!.outcome_reason_code).toBe('missing_frozen_context')
    // T-E3 with its visibility control: the W4 twin CARRIES a real legacy
    // context (so a substitution WOULD be visible here), and the W7 record
    // carries exactly NULL — never the legacy context wearing the group name.
    expect(w4!.context_snapshot).not.toBeNull()
    expect((w4!.context_snapshot as Record<string, unknown>).selector).toBe('legacy')
    expect(w7!.context_snapshot).toBeNull()
    expect(w7!.selector).toBeNull()
  })

  it('T-E2 (produced): one fail-closed target does not wedge the batch — both targets completed, the run finalized, exactly one fail-close record', async () => {
    const outcomes = (
      await pool.query(
        `SELECT o.terminal_outcome, o.failure_reason_code, t.user_id
           FROM attendance_scheduled_run_target_outcomes o
           JOIN attendance_scheduled_run_targets t ON t.id = o.target_id AND t.org_id = o.org_id
          WHERE o.org_id = $1 ORDER BY t.user_id`,
        [shadowOrg],
      )
    ).rows
    // BOTH targets' SERVED legs completed — the shadow-side fail-close is a
    // comparison record, never a target failure (uq_asrto_target holds one
    // outcome per target and the served leg owns it).
    expect(outcomes.length).toBe(2)
    for (const row of outcomes) {
      expect(row.terminal_outcome).toBe('completed')
      expect(row.failure_reason_code).toBeNull()
    }
    const run = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE org_id = $1`, [shadowOrg])
    expect(run.rows.length).toBe(1)
    expect(run.rows[0].state).toBe('completed')
    const failcloseRows = await pool.query(
      `SELECT count(*) AS n FROM attendance_record_calculations
        WHERE org_id = $1 AND (input_provenance -> '${MARKER}' ->> 'shadowReason') IS NOT NULL`,
      [shadowOrg],
    )
    expect(Number(failcloseRows.rows[0].n)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Baseline negative control: no W7 posture => no dual-run rows at all.
  // -------------------------------------------------------------------------
  it('negative control: the baseline org (no W7 posture) produced ZERO marker rows from the same run shape', async () => {
    const markerRows = await pool.query(
      `SELECT count(*) AS n FROM attendance_record_calculations
        WHERE org_id = $1 AND (input_provenance ? '${MARKER}')`,
      [baselineOrg],
    )
    expect(Number(markerRows.rows[0].n)).toBe(0)
    // Positive control in the same leg: the run really executed (a W4 shadow
    // row exists), so "zero marker rows" is not "nothing ran".
    const w4Rows = await pool.query(
      `SELECT count(*) AS n FROM attendance_record_calculations WHERE org_id = $1 AND mode = 'shadow'`,
      [baselineOrg],
    )
    expect(Number(w4Rows.rows[0].n)).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Counters over PRODUCED rows (the seeded suite's non-vacuity twin).
  // -------------------------------------------------------------------------
  it('counters (produced): coverage counts the produced comparison; the fail-close counts once; nothing double-counts', async () => {
    const result = await readAttendanceW7CompareWindowStatusV1(trx() as never, {
      orgId: shadowOrg,
      from: WINDOW.from,
      to: WINDOW.to,
    })
    const byCode = new Map(result.predicates.map((p) => [p.code, p]))
    expect(byCode.get('W7_COMPARE_COVERAGE')!.count).toBe(1) // groupUser only — the fail-close has no context
    expect(byCode.get('W7_GROUP_RESOLUTION_FAILCLOSE')!.count).toBe(1)
    expect(byCode.get('W7_CRITICAL_SHADOW_DIFF')!.count).toBe(0)
    expect(result.blocked).toBe(true) // the fail-close blocks — fail-closed window
  })

  // -------------------------------------------------------------------------
  // The dedup partition, mechanically.
  // -------------------------------------------------------------------------
  it('dedup: uq_arc_operation_w7_group_shadow admits exactly ONE comparison record per producing operation', async () => {
    const rows = await calcRowsFor(shadowOrg, groupUser)
    const w7 = rows.find((r) => r.w7_marker !== null)!
    // A duplicate marker row for the SAME (org, entrypoint, operation) must be
    // a unique violation on the W7 partition (probed in a rolled-back txn).
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      let code: string | null = null
      let constraint: string | null = null
      try {
        await client.query(
          `INSERT INTO attendance_record_calculations
             (id, attendance_record_id, org_id, version, calculation_kind, mode, entrypoint,
              engine_version, snapshot_schema_version, operation_id,
              semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
              attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
              approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
              outcome, outcome_reason_code, projection_effect, expected_segment_count,
              projected_status, projected_first_in_at, projected_last_out_at,
              projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
              shadow_diff_code, shadow_diff, actor_id, correlation_id)
           SELECT gen_random_uuid(), attendance_record_id, org_id, version + 50, calculation_kind, mode, entrypoint,
                  engine_version, snapshot_schema_version, operation_id,
                  semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
                  attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
                  approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
                  outcome, outcome_reason_code, projection_effect, expected_segment_count,
                  projected_status, projected_first_in_at, projected_last_out_at,
                  projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
                  shadow_diff_code, shadow_diff, actor_id, correlation_id
             FROM attendance_record_calculations WHERE id = $1::uuid`,
          [w7.id],
        )
      } catch (error) {
        code = (error as { code?: string }).code ?? null
        constraint = (error as { constraint?: string }).constraint ?? null
      }
      expect(code, 'the duplicate comparison insert must violate the W7 dedup partition').toBe('23505')
      expect(constraint).toBe('uq_arc_operation_w7_group_shadow')
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
