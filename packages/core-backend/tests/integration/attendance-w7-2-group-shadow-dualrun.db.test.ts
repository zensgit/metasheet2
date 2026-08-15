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
 * plugin's REAL live + scheduled adapters and the REAL core issuance seam —
 * the same offline-boundary pattern as the landed D2/D3 suites, with the seam
 * adapter being `issueAttendanceFrozenContextV1` itself rather than a stub.
 * All four recording sites are produced-driven: P1 (live authoritative, the
 * replay leg), P2 (live shadow), P3a (scheduled authoritative), P3b
 * (scheduled shadow).
 *
 * GATE COVERAGE (PR #4923 review, 2026-08-15):
 *  - P1-1: the "plan parity" block EXPLAIN-pins the gate's five enumerated
 *    replay-lookup sites (six statement instantiations — the core serves both
 *    live and scheduled) to `uq_arc_operation` — the comparison record carries
 *    `operation_id NULL` + the provenance marker, so the landed index is
 *    byte-untouched and the plans must be the pre-W7-2 plans;
 *  - P1-2: the "containment" block fault-injects the comparison recorder with
 *    session triggers and asserts the SERVED run commits either way, with the
 *    degraded fail-close record (`shadowReason: 'recorder-error'`) written
 *    when only the full comparison insert is faulted;
 *  - P2-1: the live replay leg re-punches the SAME caller-supplied
 *    operationId with the comparison record already committed and asserts the
 *    replay still succeeds with exactly one comparison record.
 *
 * These are the PRODUCED-ROW twins of the seeded legs in
 * `attendance-w7-2-compare-window-status.db.test.ts` (brief §5.0).
 *
 * Shared-DB discipline: file-namespaced random UUIDs; the suite deletes only
 * its own rows; the fault triggers are created before the leg and dropped in
 * `finally`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import {
  createAttendanceLiveScheduledBoundaryV1,
  computeAttendanceOuterSourceDefinitionFingerprintV1,
  type AttendanceLivePunchBoundaryInputV1,
  type AttendancePluginShapedTrxV1,
  type AttendanceW4LiveScheduledBoundaryV1,
} from '../../src/attendance/w4c2-live-scheduled-boundary'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import { applyAttendanceInOutMergePolicyPureV1 } from '../../src/attendance/w4c1-merge-policy'
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

type LiveAdapters = {
  insertLivePunchEventV1: (trx: unknown, args: unknown) => Promise<Record<string, unknown>>
  deriveLivePunchWorkDateResolutionV1: (trx: unknown, args: unknown) => Promise<unknown>
  applyLivePunchProjectionLegacyV1: (trx: unknown, args: unknown, mergePolicy: unknown) => Promise<unknown>
  resolveW4LiveCandidateInTransactionV1: (trx: unknown, args: unknown) => Promise<Record<string, unknown>>
  buildW4ShadowFrozenContextV1: (trx: unknown, args: unknown) => Promise<Record<string, unknown> | null>
}
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
  let live: LiveAdapters
  let scheduled: ScheduledAdapters
  let priorW4: string | undefined
  let priorW7: string | undefined
  let priorDbUrl: string | undefined
  // The live-punch path reaches the canonical active-current helper through a
  // plugin PORT that only `activate()` wires (`W4_ACTIVE_CURRENT_PORT_UNAVAILABLE`
  // otherwise), so the suite boots the real host once — the same recipe as the
  // landed D2/seam suites — while still driving its OWN boundary instance with
  // the real core seam.
  let server: MetaSheetServer | undefined

  // W4-shadow org (P3b + P2): group user + membership-gap user + live-punch user.
  const shadowOrg = randomUUID()
  const groupUser = randomUUID()
  const gapUser = randomUUID()
  const punchShadowUser = randomUUID()
  const shadowShift = randomUUID()
  const shadowGroupId = randomUUID()
  // W4-authoritative org (P3a + the P1 live replay leg): group users.
  const authOrg = randomUUID()
  const authUser = randomUUID()
  const punchAuthUser = randomUUID()
  const authShift = randomUUID()
  const authGroupId = randomUUID()
  // Baseline org: same W4 shadow shape, NO W7 posture — the dual-run must not engage.
  const baselineOrg = randomUUID()
  const baselineUser = randomUUID()
  const baselineShift = randomUUID()
  // P1-2 fault-injection orgs (their runs happen inside the legs, under triggers).
  const wedgeOrg = randomUUID()
  const wedgeUser = randomUUID()
  const wedgeShift = randomUUID()
  const wedgeGroupId = randomUUID()
  const degradedOrg = randomUUID()
  const degradedUser = randomUUID()
  const degradedShift = randomUUID()
  const degradedGroupId = randomUUID()

  const allOrgs = () => [shadowOrg, authOrg, baselineOrg, wedgeOrg, degradedOrg]
  const allUsers = () => [
    groupUser, gapUser, punchShadowUser, authUser, punchAuthUser, baselineUser, wedgeUser, degradedUser,
  ]

  // ---- fixture helpers (lifted from the landed 1b/D2/D3 suites) ------------

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

  async function seedGroupShell(orgId: string, gid: string, shiftId: string): Promise<void> {
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
  }

  async function seedGroupMember(orgId: string, gid: string, userId: string, shiftId: string): Promise<void> {
    const producerKeyLib = requireCjs(
      '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs',
    ) as { buildAttendanceGroupFixedScheduleProducerKey: (input: unknown) => string }
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
      [orgId, userId, gid, `w7-2-corr-${gid}-${userId}`],
    )
  }

  /** A user the resolvers can resolve but whose W7 group resolution
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
    const legacyAdapters = {
      applyLivePunchLegacy: (trx: unknown, args: unknown) =>
        live.applyLivePunchProjectionLegacyV1(trx, args, (input: unknown) =>
          applyAttendanceInOutMergePolicyPureV1(
            input as Parameters<typeof applyAttendanceInOutMergePolicyPureV1>[0],
          ),
        ),
      insertLivePunchEvent: (trx: unknown, args: unknown) => live.insertLivePunchEventV1(trx, args),
      deriveLivePunchWorkDateResolution: (trx: unknown, args: unknown) =>
        live.deriveLivePunchWorkDateResolutionV1(trx, args),
      resolveLiveCandidate: (trx: unknown, args: unknown) =>
        live.resolveW4LiveCandidateInTransactionV1(trx, args),
      applyScheduledAbsenceLegacy: (trx: unknown, args: { orgId: string; workDate: string; timezone: string; userIds: readonly string[] }) =>
        scheduled.generateAbsenceRecords(trx, args.orgId, args.workDate, args.timezone, args.userIds),
      resolveScheduledCandidate: (trx: unknown, args: unknown) =>
        scheduled.resolveW4ScheduledCandidateInTransactionV1(trx, args),
      buildShadowFrozenContext: (trx: unknown, args: unknown) =>
        scheduled.buildW4ShadowFrozenContextV1(trx, args),
      // THE REAL SEAM — not a stub. Deps mirror the production wrapper in
      // `plugins/plugin-attendance/index.cjs` (`issueW4FrozenContextViaW7SeamV1`).
      // `loadOrgRuleFacts` reproduces the production wrapper's DEFAULT_RULE
      // fallback for an org with no attendance-rule row (these fixture orgs
      // seed none) — the same 30/60 thresholds the legacy builder freezes for
      // rule-less orgs, asserted by the context-parity leg rather than assumed.
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
              scheduled.buildW4ShadowFrozenContextV1(pluginTrx, legacyArgs),
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

  /** The D2 recipe: pre-transaction resolution + context build + outer
   *  fingerprint, then the boundary input. `occurredAtResolved` 01:05Z =
   *  09:05 Asia/Shanghai — inside the 09:00-18:00 shift window. */
  async function buildPunchInput(
    orgId: string,
    userId: string,
    operationId: string,
  ): Promise<AttendanceLivePunchBoundaryInputV1> {
    const occurredAtResolved = '2026-05-04T01:05:00.000Z'
    const client = await pool.connect()
    let resolution: any
    let context: any = null
    try {
      const shaped: AttendancePluginShapedTrxV1 = {
        __w4CanonicalTrx: true,
        async query(sqlText: string, params?: unknown[]) {
          const res = await client.query(sqlText, params ?? [])
          return res.rows
        },
      } as never
      resolution = await live.resolveW4LiveCandidateInTransactionV1(shaped, {
        orgId,
        userId,
        occurredAt: occurredAtResolved,
        timezone: TZ,
      })
      if (resolution?.kind === 'resolved' && resolution?.shiftId) {
        context = await live.buildW4ShadowFrozenContextV1(shaped, {
          orgId,
          userId,
          workDate: String(resolution.workDate),
          shiftId: String(resolution.shiftId),
          timezone: (resolution.fullWinner as { timezone?: string } | undefined)?.timezone ?? TZ,
          isWorkday: true,
          holidayKind: null,
        })
      }
    } finally {
      client.release()
    }
    const outerSourceDefinitionFingerprint = computeAttendanceOuterSourceDefinitionFingerprintV1({
      orgId,
      userId,
      source: 'live_resolution',
      nowIso: new Date().toISOString(),
      resolution,
      context,
    } as never)
    return {
      orgId,
      userId,
      operationId,
      eventType: 'check_in',
      occurredAtRaw: null,
      occurredAtResolved,
      timezone: (resolution?.fullWinner as { timezone?: string } | undefined)?.timezone ?? TZ,
      requestTimezone: TZ,
      source: 'mobile',
      location: null,
      meta: null,
      photoFileRef: null,
      workDate: resolution?.kind === 'resolved' ? String(resolution.workDate) : WORK_DATE,
      shiftId: resolution?.kind === 'resolved' ? String(resolution.shiftId) : null,
      outerSourceDefinitionFingerprint,
      isWorkday: true,
      holidayKind: null,
    } as AttendanceLivePunchBoundaryInputV1
  }

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
      __attendanceW4c2LivePunchAdaptersForTests: LiveAdapters
      __attendanceW4c2ScheduledAdaptersForTests: ScheduledAdapters
    }
    live = plugin.__attendanceW4c2LivePunchAdaptersForTests
    scheduled = plugin.__attendanceW4c2ScheduledAdaptersForTests
    expect(typeof live?.applyLivePunchProjectionLegacyV1).toBe('function')
    expect(typeof scheduled?.generateAbsenceRecords).toBe('function')

    // Boot the real host so activate() wires the plugin's module-level ports
    // (active-current helper, W4 segment-calculation port). The suite's legs
    // never talk to the HTTP surface — the boot exists for the port wiring.
    priorDbUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../')
    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()

    priorW4 = process.env[W4_ENV]
    priorW7 = process.env[W7_ENV]
    process.env[W4_ENV] = allOrgs().join(',')
    process.env[W7_ENV] = [shadowOrg, authOrg, wedgeOrg, degradedOrg]
      .map((o) => o.toLowerCase())
      .join(',')

    // shadowOrg: W4 shadow + W7 group_shadow; group user + gap user + punch user.
    await insertShift(shadowOrg, shadowShift, 'w7-2 shadow-org shift')
    await insertActiveUser(groupUser, shadowOrg)
    await insertActiveUser(gapUser, shadowOrg)
    await insertActiveUser(punchShadowUser, shadowOrg)
    await seedGroupShell(shadowOrg, shadowGroupId, shadowShift)
    await seedGroupMember(shadowOrg, shadowGroupId, groupUser, shadowShift)
    await seedGroupMember(shadowOrg, shadowGroupId, punchShadowUser, shadowShift)
    await seedGapAssignment(shadowOrg, gapUser, shadowShift)
    await insertRolloutRow(shadowOrg, 'shadow')
    await setW7Posture(shadowOrg, 'group_shadow')

    // authOrg: W4 authoritative + W7 group_shadow; scheduled user + punch user.
    await insertShift(authOrg, authShift, 'w7-2 auth-org shift')
    await insertActiveUser(authUser, authOrg)
    await insertActiveUser(punchAuthUser, authOrg)
    await seedGroupShell(authOrg, authGroupId, authShift)
    await seedGroupMember(authOrg, authGroupId, authUser, authShift)
    await seedGroupMember(authOrg, authGroupId, punchAuthUser, authShift)
    await insertRolloutRow(authOrg, 'authoritative')
    await setW7Posture(authOrg, 'group_shadow')

    // baselineOrg: W4 shadow, NO W7 posture row.
    await insertShift(baselineOrg, baselineShift, 'w7-2 baseline shift')
    await insertActiveUser(baselineUser, baselineOrg)
    await seedGapAssignment(baselineOrg, baselineUser, baselineShift)
    await insertRolloutRow(baselineOrg, 'shadow')

    // Fault-injection orgs (runs happen inside the P1-2 legs, under triggers).
    await insertShift(wedgeOrg, wedgeShift, 'w7-2 wedge shift')
    await insertActiveUser(wedgeUser, wedgeOrg)
    await seedGroupShell(wedgeOrg, wedgeGroupId, wedgeShift)
    await seedGroupMember(wedgeOrg, wedgeGroupId, wedgeUser, wedgeShift)
    await insertRolloutRow(wedgeOrg, 'shadow')
    await setW7Posture(wedgeOrg, 'group_shadow')
    await insertShift(degradedOrg, degradedShift, 'w7-2 degraded shift')
    await insertActiveUser(degradedUser, degradedOrg)
    await seedGroupShell(degradedOrg, degradedGroupId, degradedShift)
    await seedGroupMember(degradedOrg, degradedGroupId, degradedUser, degradedShift)
    await insertRolloutRow(degradedOrg, 'shadow')
    await setW7Posture(degradedOrg, 'group_shadow')

    // ---- the three baseline PRODUCING runs, one per org ----
    const boundary = makeBoundary()
    await boundary.executeScheduledRun(scheduledInput(shadowOrg, [groupUser, gapUser]))
    await boundary.executeScheduledRun(scheduledInput(authOrg, [authUser]))
    await boundary.executeScheduledRun(scheduledInput(baselineOrg, [baselineUser]))
  }, 180_000)

  afterAll(async () => {
    const orgs = allOrgs()
    await pool?.query('DROP TRIGGER IF EXISTS trg_w72_fault_all ON attendance_record_calculations').catch(() => undefined)
    await pool?.query('DROP TRIGGER IF EXISTS trg_w72_fault_full ON attendance_record_calculations').catch(() => undefined)
    await pool?.query('DROP FUNCTION IF EXISTS w72_fault_comparison_insert()').catch(() => undefined)
    for (const table of [
      'attendance_record_segments',
      'attendance_record_calculations',
      'attendance_result_event_outbox',
      'attendance_scheduled_run_target_outcomes',
      'attendance_scheduled_run_targets',
      'attendance_result_operations',
      'attendance_scheduled_runs',
      'attendance_events',
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
    await (server as { stop?: () => Promise<void> } | undefined)?.stop?.()
    if (priorDbUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorDbUrl
    if (priorW4 === undefined) delete process.env[W4_ENV]
    else process.env[W4_ENV] = priorW4
    if (priorW7 === undefined) delete process.env[W7_ENV]
    else process.env[W7_ENV] = priorW7
  }, 60_000)

  // -------------------------------------------------------------------------
  // T-A2 + T-D1 (produced): the dual-run wrote BOTH rows for one target.
  // -------------------------------------------------------------------------
  it('T-A2/T-D1 (produced, P3b): one scheduled operation wrote the W4 shadow row AND the W7 comparison record — marker-correlated, operation_id NULL, opposite selectors', async () => {
    const rows = await calcRowsFor(shadowOrg, groupUser)
    const w4Rows = rows.filter((r) => r.w7_marker === null && r.mode === 'shadow')
    const w7Rows = rows.filter((r) => r.w7_marker !== null)
    expect(w4Rows.length, 'exactly one W4 shadow row').toBe(1)
    expect(w7Rows.length, 'exactly one W7 comparison record').toBe(1)
    const w4 = w4Rows[0]
    const w7 = w7Rows[0]
    // The comparison record is NOT the operation's result: its operation_id
    // column is NULL (chk_arc_operation_id marker disjunct) and the producing
    // operation travels in the marker — `uq_arc_operation` stays untouched.
    expect(w7.operation_id).toBeNull()
    expect(w7.w7_marker).toEqual({ schemaVersion: 1, operationId: w4.operation_id, shadowReason: null })
    expect(w4.entrypoint).toBe('scheduled')
    expect(w7.entrypoint).toBe('scheduled')
    expect(Number(w7.version)).toBe(Number(w4.version) + 1)
    // The selector discriminator, produced: legacy vs group_effective.
    expect(w4.selector).toBe('legacy')
    expect(w7.selector).toBe('group_effective')
    expect(w7.mode).toBe('shadow')
    expect(w7.calculation_tier).toBe('legacy_shadow')
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
    for (const key of [
      'orgId', 'userId', 'workDate', 'timezone', 'shiftId', 'isWorkday', 'holidayKind',
      'roundingMinutes', 'severeLateThresholdMinutes', 'absenceLateThresholdMinutes', 'segments',
    ]) {
      expect(v2[key], `context member ${key}`).toEqual(v1[key])
    }
    expect(w7.outcome).toBe(w4.outcome)
    expect(w7.shadow_diff_code).toBe(w4.shadow_diff_code)
  })

  // -------------------------------------------------------------------------
  // T-A5 (produced): W7-R8 — shadow by construction, pointer untouched.
  // -------------------------------------------------------------------------
  it('T-A5 (produced): the W7 record is projection_effect=none and the parent pointer is untouched on BOTH org postures', async () => {
    const shadowRows = await calcRowsFor(shadowOrg, groupUser)
    const w7Shadow = shadowRows.find((r) => r.w7_marker !== null)!
    expect(w7Shadow.projection_effect).toBe('none')
    expect(w7Shadow.current_calculation_id).toBeNull()
    expect(w7Shadow.projection_owner).toBe('legacy_untracked')

    const authRows = await calcRowsFor(authOrg, authUser)
    const w7Auth = authRows.find((r) => r.w7_marker !== null)
    const served = authRows.find((r) => r.mode === 'authoritative')
    expect(w7Auth, 'P3a must record a comparison too').toBeTruthy()
    expect(served, 'the authoritative served row must exist').toBeTruthy()
    expect(w7Auth!.projection_effect).toBe('none')
    if (served!.outcome === 'completed') {
      expect(w7Auth!.current_calculation_id).toBe(served!.id)
    } else {
      expect(w7Auth!.current_calculation_id).toBeNull()
    }
    // DB-level backstop: mutating a comparison record into a served one is
    // rejected (immutability trigger / CHECK matrix — probed in a rolled-back
    // transaction).
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
      expect(code, 'mutating a W7 comparison record into a served one must be rejected').not.toBeNull()
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
    expect(w7!.operation_id).toBeNull()
    expect(w7!.w7_marker).toEqual({
      schemaVersion: 1,
      operationId: w4!.operation_id,
      shadowReason: 'membership-absent',
    })
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
        WHERE org_id = $1 AND (input_provenance -> $2 ->> 'shadowReason') IS NOT NULL`,
      [shadowOrg, MARKER],
    )
    expect(Number(failcloseRows.rows[0].n)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Baseline negative control: no W7 posture => no dual-run rows at all.
  // -------------------------------------------------------------------------
  it('negative control: the baseline org (no W7 posture) produced ZERO marker rows from the same run shape', async () => {
    const markerRows = await pool.query(
      `SELECT count(*) AS n FROM attendance_record_calculations
        WHERE org_id = $1 AND (input_provenance ? $2)`,
      [baselineOrg, MARKER],
    )
    expect(Number(markerRows.rows[0].n)).toBe(0)
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
    // groupUser + punchShadowUser (the P2 punch leg may run before or after
    // this leg — tolerate both by asserting membership, then exact counts on
    // the scheduled-only facts).
    expect(byCode.get('W7_COMPARE_COVERAGE')!.count).toBeGreaterThanOrEqual(1)
    expect(byCode.get('W7_GROUP_RESOLUTION_FAILCLOSE')!.count).toBe(1)
    expect(byCode.get('W7_CRITICAL_SHADOW_DIFF')!.count).toBe(0)
    expect(result.blocked).toBe(true) // the fail-close blocks — fail-closed window
  })

  // -------------------------------------------------------------------------
  // P2 (live shadow) produced-row leg + P1 live replay leg (gate P1-2/P2-1).
  // -------------------------------------------------------------------------
  it('P2 (produced, live): a live punch on the W4-shadow org records the comparison beside the W4 shadow row', async () => {
    const boundary = makeBoundary()
    const operationId = randomUUID()
    const result = await boundary.executeLivePunch(await buildPunchInput(shadowOrg, punchShadowUser, operationId))
    expect(result.kind).toBe('w4')
    const rows = await calcRowsFor(shadowOrg, punchShadowUser)
    const w4 = rows.find((r) => r.w7_marker === null && r.mode === 'shadow' && r.entrypoint === 'live')
    const w7 = rows.find((r) => r.w7_marker !== null && r.entrypoint === 'live')
    expect(w4, 'the live W4 shadow row exists').toBeTruthy()
    expect(w7, 'the live W7 comparison record exists').toBeTruthy()
    expect(w4!.operation_id).toBe(operationId)
    expect(w7!.operation_id).toBeNull()
    expect(w7!.w7_marker).toEqual({ schemaVersion: 1, operationId, shadowReason: null })
    expect(w7!.selector).toBe('group_effective')
  })

  it('P1 + replay (gate P2-1, produced): re-punching the SAME operationId with the comparison record committed still replays — one served row, one comparison record, no wedge', async () => {
    const boundary = makeBoundary()
    const operationId = randomUUID()
    const first = await boundary.executeLivePunch(await buildPunchInput(authOrg, punchAuthUser, operationId))
    expect(first.kind).toBe('w4')
    const afterFirst = await calcRowsFor(authOrg, punchAuthUser)
    const served1 = afterFirst.filter((r) => r.mode === 'authoritative' && r.entrypoint === 'live')
    const compare1 = afterFirst.filter((r) => r.w7_marker !== null && r.entrypoint === 'live')
    expect(served1.length, 'exactly one served authoritative row').toBe(1)
    expect(compare1.length, 'exactly one comparison record').toBe(1)
    expect(compare1[0].w7_marker).toEqual({ schemaVersion: 1, operationId, shadowReason: null })

    // THE REPLAY: same caller-supplied operationId. The replay lookup runs
    // against a table that now holds BOTH the served row and the marker
    // record — the marker record is structurally invisible to it
    // (operation_id NULL), so the retry must succeed and must not mint a
    // second row of either kind.
    const second = await boundary.executeLivePunch(await buildPunchInput(authOrg, punchAuthUser, operationId))
    // POSITIVE equality on the replay outcome (the registry replays the
    // sealed operation) — `'w4'` here would mean the operation re-executed,
    // which is exactly what a replay must not do.
    expect(second.kind).toBe('replay')
    const afterSecond = await calcRowsFor(authOrg, punchAuthUser)
    expect(
      afterSecond.filter((r) => r.mode === 'authoritative' && r.entrypoint === 'live').length,
      'replay minted no second served row',
    ).toBe(1)
    expect(
      afterSecond.filter((r) => r.w7_marker !== null && r.entrypoint === 'live').length,
      'replay minted no second comparison record',
    ).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Gate P1-1 — plan parity: the five replay-lookup statement shapes still
  // use `uq_arc_operation` (the comparison record never entered its domain).
  // Probed with the generic planner paths disabled so the assertion pins
  // INDEX USABILITY, which is exactly what the refuted split destroyed.
  // -------------------------------------------------------------------------
  it('P1-1 plan parity: every operation-replay lookup shape (the gate’s five sites, six instantiations) plans onto uq_arc_operation with the full three-column Index Cond', async () => {
    const shapes: ReadonlyArray<{ site: string; sql: string }> = [
      {
        site: 'w4c2-authoritative-calculation-core.ts retryReplayLookup',
        sql: `SELECT id::text AS id, attendance_record_id::text AS record_id, input_provenance
                FROM attendance_record_calculations
               WHERE org_id = 'w72-plan-org' AND entrypoint = 'live' AND operation_id = '${randomUUID()}'::uuid
               FOR UPDATE`,
      },
      {
        site: 'w4c2-authoritative-calculation-core.ts retryReplayLookup (scheduled)',
        sql: `SELECT id::text AS id FROM attendance_record_calculations
               WHERE org_id = 'w72-plan-org' AND entrypoint = 'scheduled' AND operation_id = '${randomUUID()}'::uuid
               FOR UPDATE`,
      },
      {
        site: 'w4c3c-recompute.ts replay lookup',
        sql: `SELECT id::text AS id, attendance_record_id::text AS attendance_record_id, input_provenance
                FROM attendance_record_calculations
               WHERE org_id = 'w72-plan-org' AND entrypoint = 'recompute' AND operation_id = '${randomUUID()}'::uuid
               FOR UPDATE`,
      },
      {
        site: 'w4c3c-ops-retirement.ts replay lookup',
        sql: `SELECT id::text AS id FROM attendance_record_calculations
               WHERE org_id = 'w72-plan-org' AND entrypoint = 'ops_retirement' AND operation_id = '${randomUUID()}'::uuid
               FOR UPDATE`,
      },
      {
        site: 'w4c3c-manual-edit-apply.ts replay lookup',
        sql: `SELECT id::text AS id FROM attendance_record_calculations
               WHERE org_id = 'w72-plan-org' AND entrypoint = 'manual_override' AND operation_id = '${randomUUID()}'::uuid
               FOR UPDATE`,
      },
      {
        site: 'w4c3b-approved-leave-cancellation.ts replay lookup',
        sql: `SELECT id::text AS id FROM attendance_record_calculations
               WHERE org_id = 'w72-plan-org' AND entrypoint = 'approval_reversal' AND operation_id = '${randomUUID()}'::uuid
               FOR UPDATE`,
      },
    ]
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // A realistic table, the gate's E2b shape: several hundred calculation
      // rows over hundreds of records, ANALYZEd, DEFAULT planner — an empty
      // table's degenerate cost model can tie-break onto `idx_arc_record`
      // even when `uq_arc_operation` is perfectly usable, which is exactly
      // the ambiguity that let the refuted migration's regression hide.
      // Everything (rows AND the transactional ANALYZE stats) rolls back.
      await client.query(`
        INSERT INTO attendance_records
          (id, user_id, org_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes,
           status, is_workday, projection_owner, visibility_state, visibility_reason, created_at, updated_at)
        SELECT gen_random_uuid(), 'w72-plan-user-' || i, 'w72-plan-org',
               DATE '2026-04-01' + (i % 28), 'UTC', 480, 0, 0,
               'normal', true, 'legacy_untracked', 'active', 'active', now(), now()
          FROM generate_series(1, 400) AS s(i)`)
      await client.query(`
        INSERT INTO attendance_record_calculations
          (id, attendance_record_id, org_id, version, calculation_kind, mode, entrypoint,
           engine_version, snapshot_schema_version, operation_id,
           semantic_input_fingerprint, provenance_fingerprint,
           attribution_snapshot, segment_snapshot, evidence_snapshot, approved_facts_snapshot,
           input_provenance, merge_policy, calculation_tier,
           outcome, outcome_reason_code, projection_effect, expected_segment_count,
           actor_id, correlation_id)
        SELECT gen_random_uuid(), r.id, r.org_id, gs.v, 'calculation', 'shadow',
               CASE WHEN (row_number() OVER (ORDER BY r.id)) % 2 = 0 THEN 'live' ELSE 'scheduled' END,
               'w72-plan', 1, gen_random_uuid(),
               md5(r.id::text) || md5(r.id::text || 'a'), md5(r.id::text || 'b') || md5(r.id::text || 'c'),
               '{"posture":"unsupported","sourceSchemaVersion":null,"reason":"unresolved","sourceFingerprint":null}'::jsonb,
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
               '{}'::jsonb, 'append', 'legacy_shadow',
               'review_required', 'missing_frozen_context', 'none', 0,
               'w72-plan-actor', 'w72-plan-corr'
          FROM attendance_records r
          CROSS JOIN (VALUES (1), (2)) AS gs(v)
         WHERE r.org_id = 'w72-plan-org'`)
      await client.query('ANALYZE attendance_record_calculations')
      for (const shape of shapes) {
        const plan = (await client.query(`EXPLAIN ${shape.sql}`)).rows
          .map((r) => String(r['QUERY PLAN']))
          .join('\n')
        expect(plan, `${shape.site}: must plan onto uq_arc_operation\n${plan}`).toContain(
          'uq_arc_operation',
        )
        expect(plan, `${shape.site}: full three-column Index Cond\n${plan}`).toMatch(
          /Index Cond: .*org_id.*entrypoint.*operation_id/s,
        )
      }
      // POSITIVE CONTROL — the probe can SEE the regression it guards: with
      // the index gone (transactionally), the same statement must stop
      // planning onto it. Without this, "plan contains uq_arc_operation"
      // could be satisfied by a probe that reads nothing.
      await client.query('SAVEPOINT w72_plan_control')
      await client.query('DROP INDEX uq_arc_operation')
      const degradedPlan = (await client.query(`EXPLAIN ${shapes[0].sql}`)).rows
        .map((r) => String(r['QUERY PLAN']))
        .join('\n')
      expect(degradedPlan.includes('uq_arc_operation')).toBe(false)
      await client.query('ROLLBACK TO SAVEPOINT w72_plan_control')
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }, 60_000)

  // -------------------------------------------------------------------------
  // Gate P1-2 — the comparison recorder is fail-isolated from the served arm.
  // -------------------------------------------------------------------------
  it('P1-2 containment (total fault): with EVERY comparison insert faulted, the served scheduled run still commits and finalizes', async () => {
    const client = await pool.connect()
    try {
      await client.query(`
        CREATE OR REPLACE FUNCTION w72_fault_comparison_insert() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'W72_FAULT_INJECTED_COMPARISON_INSERT';
        END
        $$ LANGUAGE plpgsql`)
      await client.query(`
        CREATE TRIGGER trg_w72_fault_all
          BEFORE INSERT ON attendance_record_calculations
          FOR EACH ROW
          WHEN (NEW.input_provenance ? 'w7GroupShadowCompare')
          EXECUTE FUNCTION w72_fault_comparison_insert()`)
      const boundary = makeBoundary()
      // The run must complete despite BOTH recorder attempts (full + degraded)
      // failing for every target — the served half is fail-isolated.
      await boundary.executeScheduledRun(scheduledInput(wedgeOrg, [wedgeUser]))
      const outcomes = await pool.query(
        `SELECT terminal_outcome FROM attendance_scheduled_run_target_outcomes WHERE org_id = $1`,
        [wedgeOrg],
      )
      expect(outcomes.rows.length).toBe(1)
      expect(outcomes.rows[0].terminal_outcome).toBe('completed')
      const run = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE org_id = $1`, [wedgeOrg])
      expect(run.rows[0].state).toBe('completed')
      // The served half is intact and the faulted half left nothing behind.
      const rows = await calcRowsFor(wedgeOrg, wedgeUser)
      expect(rows.filter((r) => r.w7_marker === null && r.mode === 'shadow').length).toBe(1)
      expect(rows.filter((r) => r.w7_marker !== null).length).toBe(0)
    } finally {
      await client.query('DROP TRIGGER IF EXISTS trg_w72_fault_all ON attendance_record_calculations').catch(() => undefined)
      client.release()
    }
  })

  it('P1-2 containment (partial fault): with only the FULL comparison insert faulted, the degraded fail-close record lands (shadowReason recorder-error) and the run commits', async () => {
    const client = await pool.connect()
    try {
      await client.query(`
        CREATE OR REPLACE FUNCTION w72_fault_comparison_insert() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'W72_FAULT_INJECTED_COMPARISON_INSERT';
        END
        $$ LANGUAGE plpgsql`)
      // Fault only context-bearing comparison inserts: the degraded record
      // (context NULL) passes, which is the disposition-3 path.
      await client.query(`
        CREATE TRIGGER trg_w72_fault_full
          BEFORE INSERT ON attendance_record_calculations
          FOR EACH ROW
          WHEN (NEW.input_provenance ? 'w7GroupShadowCompare' AND NEW.context_snapshot IS NOT NULL)
          EXECUTE FUNCTION w72_fault_comparison_insert()`)
      const boundary = makeBoundary()
      await boundary.executeScheduledRun(scheduledInput(degradedOrg, [degradedUser]))
      const run = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE org_id = $1`, [degradedOrg])
      expect(run.rows[0].state).toBe('completed')
      const rows = await calcRowsFor(degradedOrg, degradedUser)
      const w4 = rows.find((r) => r.w7_marker === null && r.mode === 'shadow')
      const degraded = rows.find((r) => r.w7_marker !== null)
      expect(w4, 'served W4 shadow row intact').toBeTruthy()
      expect(degraded, 'the degraded fail-close record landed').toBeTruthy()
      expect(degraded!.context_snapshot).toBeNull()
      expect(degraded!.operation_id).toBeNull()
      expect(degraded!.w7_marker).toEqual({
        schemaVersion: 1,
        operationId: w4!.operation_id,
        shadowReason: 'recorder-error',
      })
      // ...and the compare window BLOCKS on it — the failure is a counted
      // fail-close, never a silent gap.
      const status = await readAttendanceW7CompareWindowStatusV1(trx() as never, {
        orgId: degradedOrg,
        from: WINDOW.from,
        to: WINDOW.to,
      })
      const failclose = status.predicates.find((p) => p.code === 'W7_GROUP_RESOLUTION_FAILCLOSE')!
      expect(failclose.count).toBe(1)
      expect(status.blocked).toBe(true)
    } finally {
      await client.query('DROP TRIGGER IF EXISTS trg_w72_fault_full ON attendance_record_calculations').catch(() => undefined)
      await client.query('DROP FUNCTION IF EXISTS w72_fault_comparison_insert()').catch(() => undefined)
      client.release()
    }
  })

  // -------------------------------------------------------------------------
  // The comparison identity, mechanically.
  // -------------------------------------------------------------------------
  it('identity: uq_arc_w7_comparison_identity admits exactly ONE comparison record per producing operation', async () => {
    const rows = await calcRowsFor(shadowOrg, groupUser)
    const w7 = rows.find((r) => r.w7_marker !== null)!
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
      expect(code, 'the duplicate comparison insert must violate the identity index').toBe('23505')
      expect(constraint).toBe('uq_arc_w7_comparison_identity')
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('identity (CHECK): a comparison record cannot re-enter the uq_arc_operation domain — a marker row with a non-null operation_id is unrepresentable', async () => {
    const rows = await calcRowsFor(shadowOrg, groupUser)
    const w7 = rows.find((r) => r.w7_marker !== null)!
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
           SELECT gen_random_uuid(), attendance_record_id, org_id, version + 60, calculation_kind, mode, entrypoint,
                  engine_version, snapshot_schema_version, gen_random_uuid(),
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
      expect(code, 'a marker row with an operation_id must trip chk_arc_operation_id').toBe('23514')
      expect(constraint).toBe('chk_arc_operation_id')
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
