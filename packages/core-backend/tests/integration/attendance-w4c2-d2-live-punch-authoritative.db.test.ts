/**
 * W4C-2 Gate D2 (#4556 / #4844) — real-Postgres proof of the AUTHORITATIVE `live_punch` writer in
 * `src/attendance/w4c2-live-scheduled-boundary.ts`.
 *
 * WHAT THIS DRIVES: the production boundary factory
 * (`createAttendanceLiveScheduledBoundaryV1`) over a real pool, wired to the REAL plugin adapters
 * exported at `plugin-attendance/index.cjs :: __attendanceW4c2LivePunchAdaptersForTests` — the same
 * functions `activate` injects. Only the SCHEDULED adapters (never exercised here) are stubs. The
 * adapters are wrapped in call-count spies, which is what makes the P-A control-flow pin
 * (zero `applyLivePunchLegacy` invocations on the authoritative path) an observation rather than
 * an argument.
 *
 * WHY IT IS NOT PRODUCTION-REACHABLE ANYWAY: `effectiveState === 'authoritative'` additionally
 * requires an EXACT-org entry in `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` (wildcard never
 * counts). This suite sets that env for its own throwaway org ids; production leaves it unset, so
 * every production org collapses to `legacy` and this branch is unreachable irrespective of DB
 * contents.
 *
 * Shared-DB discipline: every fixture identity is a run-namespaced UUID; W4 calculation/operation/
 * outbox rows are append-only by design and are left behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import net from 'net'
import * as path from 'path'
import { createRequire } from 'module'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import { up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import {
  createAttendanceLiveScheduledBoundaryV1,
  computeAttendanceOuterSourceDefinitionFingerprintV1,
  insertAuthoritativeReviewPlaceholderParentV1,
  type AttendanceLivePunchBoundaryInputV1,
  type AttendancePluginShapedTrxV1,
  type AttendanceW4LiveScheduledBoundaryV1,
} from '../../src/attendance/w4c2-live-scheduled-boundary'
import { computeAttendanceImportRollbackPreimageFingerprintV1 } from '../../src/attendance/w4c3a-import-rollback'
import { loadActiveCurrentAttendanceRecordForDecisionTraceV1 } from '../../src/attendance/w4c3c-active-current'
// The SAME recursive key-path instrument the legacy golden-response guard uses, so the
// authoritative/legacy parity leg compares with the repo's existing tool rather than a new one.
import { recursiveKeyPaths } from '../utils/attendance-w4c2-golden-response'
import {
  projectedDailyFingerprintV1,
  writeAuthoritativeReversalV1,
} from '../../src/attendance/w4c2-authoritative-calculation-core'
import { applyAttendanceInOutMergePolicyPureV1 } from '../../src/attendance/w4c1-merge-policy'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const TZ = 'Asia/Shanghai'
const WORK_DATE = '2026-05-04'
const requireCjs = createRequire(import.meta.url)

function uuid(): string {
  return crypto.randomUUID()
}

type LivePunchAdapters = {
  insertLivePunchEventV1: (trx: AttendancePluginShapedTrxV1, args: unknown) => Promise<Record<string, unknown>>
  deriveLivePunchWorkDateResolutionV1: (trx: AttendancePluginShapedTrxV1, args: unknown) => Promise<unknown>
  applyLivePunchProjectionLegacyV1: (
    trx: AttendancePluginShapedTrxV1,
    args: unknown,
    mergePolicyPure: unknown,
  ) => Promise<{ event: Record<string, unknown>; record: Record<string, unknown>; workDateResolution: unknown }>
  resolveW4LiveCandidateInTransactionV1: (trx: AttendancePluginShapedTrxV1, args: unknown) => Promise<any>
  buildW4ShadowFrozenContextV1: (trx: AttendancePluginShapedTrxV1, args: unknown) => Promise<any>
}

describeIfDatabase('W4C-2 Gate D2 — authoritative live_punch writer (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let migrationDb: Kysely<unknown> | undefined
  let adapters: LivePunchAdapters
  let priorAllowlistEnv: string | undefined
  let server: MetaSheetServer | undefined
  const allowlistedOrgs: string[] = []

  /** Registers an org in the exact-org env allowlist BEFORE any boundary call for it. */
  function allow(orgId: string): string {
    allowlistedOrgs.push(orgId)
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = allowlistedOrgs.join(',')
    return orgId
  }

  beforeAll(async () => {
    migrationDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }),
    })
    await up(migrationDb)
    priorAllowlistEnv = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED

    // The plugin's in-transaction W2 resolver reaches the canonical active-current helper port,
    // which only `activate` installs — so a real server boot is required to drive the REAL
    // adapters rather than re-implementing them. The boundary instances under test are still
    // constructed HERE (with spies), not taken from activate.
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('W4C-2 Gate D2 suite needs a loopback port + DATABASE_URL')
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()

    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW4c2LivePunchAdaptersForTests: LivePunchAdapters
    }
    adapters = plugin.__attendanceW4c2LivePunchAdaptersForTests
  }, 180000)

  afterAll(async () => {
    if (priorAllowlistEnv === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlistEnv
    await server?.stop?.()
    await migrationDb?.destroy()
    await pool.end()
  })

  // ---- boundary driver ----------------------------------------------------

  interface Spies {
    applyLivePunchLegacy: number
    insertLivePunchEvent: number
  }

  function makeBoundary(): { boundary: AttendanceW4LiveScheduledBoundaryV1; spies: Spies } {
    const spies: Spies = { applyLivePunchLegacy: 0, insertLivePunchEvent: 0 }
    const boundary = createAttendanceLiveScheduledBoundaryV1({
      acquireConnection: async () => {
        const client = await pool.connect()
        return { client: client as unknown as AttendanceW4TransactionClientV1, release: () => client.release() }
      },
      legacyAdapters: {
        applyLivePunchLegacy: (trx, args) => {
          spies.applyLivePunchLegacy += 1
          return adapters.applyLivePunchProjectionLegacyV1(trx, args, (input: unknown) =>
            applyAttendanceInOutMergePolicyPureV1(
              input as Parameters<typeof applyAttendanceInOutMergePolicyPureV1>[0],
            ),
          )
        },
        insertLivePunchEvent: (trx, args) => {
          spies.insertLivePunchEvent += 1
          return adapters.insertLivePunchEventV1(trx, args)
        },
        deriveLivePunchWorkDateResolution: (trx, args) =>
          adapters.deriveLivePunchWorkDateResolutionV1(trx, args),
        applyScheduledAbsenceLegacy: async () => [],
        resolveLiveCandidate: (trx, args) => adapters.resolveW4LiveCandidateInTransactionV1(trx, args),
        resolveScheduledCandidate: async () => ({ kind: 'unresolved' as const }),
        buildShadowFrozenContext: (trx, args) => adapters.buildW4ShadowFrozenContextV1(trx, args),
        // W7-1b: the issuance seam is now a REQUIRED adapter (folded into the
        // same fail-closed gate). With no posture row — this suite never writes
        // one — the real seam takes the legacy arm, so this fixture reproduces
        // exactly that and the suite keeps measuring what it already measured.
        issueFrozenContext: async (trx, args) => ({
          arm: 'legacy' as const,
          context: await adapters.buildW4ShadowFrozenContextV1(trx, args),
          reason: null,
        }),
      },
    })
    return { boundary, spies }
  }

  // ---- fixtures -----------------------------------------------------------

  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-2 d2 fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w4c2-d2.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }

  /** Walks the rollout row's legal edges to `authoritative` (the tool refuses this promotion). */
  async function walkRolloutToAuthoritative(orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'w4c2-d2', 'TEST_FIXTURE', 'w4c2-d2-actor', 1, NULL)`,
      [orgId],
    )
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

  async function insertRolloutState(orgId: string, state: 'shadow'): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, $2, 'w4c2-d2', 'TEST_FIXTURE', 'w4c2-d2-actor', 1, NULL)`,
      [orgId, state],
    )
  }

  async function insertShiftAndAssignment(orgId: string, userId: string): Promise<string> {
    const shiftId = uuid()
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time, timezone)
       VALUES ($1, $2, $3, '09:00', '18:00', $4)`,
      [shiftId, orgId, `w4c2-d2-${RUN}`, TZ],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
       VALUES ($1, $2, $3, $4, 0, '2026-05-01', NULL, true, 'published', 'regular')`,
      [uuid(), orgId, userId, shiftId],
    )
    return shiftId
  }

  /**
   * An OVERNIGHT shift (22:00 -> 06:00 local), which is what makes the open-record tie-break in
   * `selectAmongMatchingCandidates` reachable: that branch requires a candidate that
   * `isOvernight` AND whose `workDate` is strictly before the punch's `calendarWorkDate`.
   */
  async function insertOvernightShiftAndAssignment(orgId: string, userId: string): Promise<string> {
    const shiftId = uuid()
    // `is_overnight` must be set EXPLICITLY: the column defaults to `false`, and the resolver's
    // `resolveOvernightFlag` honours an explicit flag over inferring one from the times, so a
    // 22:00->06:00 shift left at the default builds an end-before-start absolute window and the
    // candidate is rejected as MALFORMED_CANDIDATE_SHAPE before any tie-break runs.
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time, timezone, is_overnight)
       VALUES ($1, $2, $3, '22:00', '06:00', $4, true)`,
      [shiftId, orgId, `w4c2-d2-overnight-${RUN}`, TZ],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments
         (org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
       VALUES ($1, $2, 0, '22:00', 0, '06:00', 1)`,
      [orgId, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
       VALUES ($1, $2, $3, $4, 0, '2026-05-01', NULL, true, 'published', 'regular')`,
      [uuid(), orgId, userId, shiftId],
    )
    return shiftId
  }

  /** Runs the plugin's REAL wire-echo derivation on its own connection, outside any punch. */
  async function deriveWorkDateResolutionOutOfBand(
    seed: { orgId: string; userId: string },
    occurredAtResolved: string,
  ): Promise<Record<string, unknown>> {
    const client = await pool.connect()
    try {
      const shaped: AttendancePluginShapedTrxV1 = {
        __w4CanonicalTrx: true,
        async query(sqlText: string, params?: unknown[]) {
          const res = await client.query(sqlText, params ?? [])
          return res.rows
        },
      }
      return (await adapters.deriveLivePunchWorkDateResolutionV1(shaped, {
        orgId: seed.orgId,
        userId: seed.userId,
        occurredAt: occurredAtResolved,
        requestTimezone: TZ,
      })) as Record<string, unknown>
    } finally {
      client.release()
    }
  }

  /**
   * An org + user seeded for authoritative punches. `withShift` decides whether the freeze step
   * can resolve a `resolved_v2` attribution at all (no shift => unsupported => review_required).
   */
  async function seedAuthoritativeOrg(
    label: string,
    options: { withShift?: boolean } = {},
  ): Promise<{ orgId: string; userId: string; shiftId: string | null }> {
    const orgId = allow(uuid())
    const userId = uuid()
    await insertActiveUser(userId, orgId)
    await walkRolloutToAuthoritative(orgId)
    const shiftId = options.withShift === true ? await insertShiftAndAssignment(orgId, userId) : null
    void label
    return { orgId, userId, shiftId }
  }

  /**
   * Builds the boundary input the ROUTE would build, including the OUTER (pre-transaction)
   * source-definition fingerprint. Computing it the way the route does — a non-transactional
   * resolve + context build, then `computeAttendanceOuterSourceDefinitionFingerprintV1` — is what
   * keeps an ordinary punch out of the identity-drift branch; passing `null` blindly would make
   * every resolved punch false-drift into `review_required`.
   */
  async function buildPunchInput(
    seed: { orgId: string; userId: string },
    overrides: Partial<AttendanceLivePunchBoundaryInputV1> = {},
  ): Promise<AttendanceLivePunchBoundaryInputV1> {
    const occurredAtResolved = (overrides.occurredAtResolved as string) ?? '2026-05-04T01:05:00.000Z'
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
      }
      resolution = await adapters.resolveW4LiveCandidateInTransactionV1(shaped, {
        orgId: seed.orgId,
        userId: seed.userId,
        occurredAt: occurredAtResolved,
        timezone: TZ,
      })
      if (resolution?.kind === 'resolved' && resolution?.shiftId) {
        context = await adapters.buildW4ShadowFrozenContextV1(shaped, {
          orgId: seed.orgId,
          userId: seed.userId,
          workDate: String(resolution.workDate),
          shiftId: String(resolution.shiftId),
          timezone: resolution.fullWinner?.timezone ?? TZ,
          isWorkday: true,
          holidayKind: null,
        })
      }
    } finally {
      client.release()
    }
    const outerSourceDefinitionFingerprint = computeAttendanceOuterSourceDefinitionFingerprintV1({
      orgId: seed.orgId,
      userId: seed.userId,
      source: 'live_resolution',
      nowIso: new Date().toISOString(),
      resolution,
      context,
    })
    return {
      orgId: seed.orgId,
      userId: seed.userId,
      operationId: uuid(),
      eventType: 'check_in',
      occurredAtRaw: null,
      occurredAtResolved,
      timezone: resolution?.fullWinner?.timezone ?? TZ,
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
      ...overrides,
    }
  }

  // ---- readers ------------------------------------------------------------

  async function parentRow(userId: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await pool.query(
      `SELECT id::text AS id, status, first_in_at, last_out_at, work_minutes, late_minutes,
              early_leave_minutes, projection_owner, current_calculation_id::text AS current_calculation_id,
              visibility_state, visibility_reason
         FROM attendance_records WHERE user_id = $1`,
      [userId],
    )
    return rows[0]
  }

  async function calcRows(userId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `SELECT c.id::text AS id, c.version, c.calculation_kind, c.mode, c.entrypoint, c.outcome,
              c.outcome_reason_code, c.projection_effect, c.expected_segment_count,
              c.projected_status, c.projected_daily_fingerprint,
              c.semantic_input_fingerprint, c.input_provenance,
              c.supersedes_calculation_id::text AS supersedes_calculation_id
         FROM attendance_record_calculations c
         JOIN attendance_records r ON r.id = c.attendance_record_id
        WHERE r.user_id = $1
        ORDER BY c.version`,
      [userId],
    )
    return rows
  }

  async function eventCount(userId: string): Promise<number> {
    return Number((await pool.query('SELECT count(*)::int AS n FROM attendance_events WHERE user_id = $1', [userId])).rows[0].n)
  }

  async function outboxRows(orgId: string): Promise<Array<Record<string, unknown>>> {
    return (await pool.query(
      `SELECT id::text AS id, event_kind FROM attendance_result_event_outbox WHERE org_id = $1`,
      [orgId],
    )).rows
  }

  async function operationRows(orgId: string): Promise<Array<Record<string, unknown>>> {
    return (await pool.query(
      `SELECT operation_id::text AS operation_id, state, resolved_record_id::text AS resolved_record_id,
              resolved_calculation_id::text AS resolved_calculation_id, response_snapshot,
              result_semantic_fingerprint
         FROM attendance_result_operations WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    )).rows
  }

  async function segmentCount(calculationId: string): Promise<number> {
    return Number((await pool.query(
      'SELECT count(*)::int AS n FROM attendance_record_segments WHERE calculation_id = $1::uuid',
      [calculationId],
    )).rows[0].n)
  }

  /** Inserts a legacy-ACTIVE parent for the day (the compat-fingerprint / baseline case). */
  async function insertLegacyActiveParent(orgId: string, userId: string, workDate: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO attendance_records
         (user_id, work_date, org_id, timezone, status, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes)
       VALUES ($1, $2::date, $3, $4, 'normal', $5, $6, 420, 0, 0)
       RETURNING id::text AS id`,
      [userId, workDate, orgId, TZ, '2026-05-04T01:30:00.000Z', '2026-05-04T08:30:00.000Z'],
    )
    return String(rows[0].id)
  }

  // =========================================================================
  // GATING LEG (leg 2) — build-ready precondition.
  // =========================================================================

  it('leg 2 [GATING]: fresh COMPLETED with an absent parent creates the placeholder then promotes it to w4/active/active — and NO legacy_baseline row exists', async () => {
    const seed = await seedAuthoritativeOrg('g2', { withShift: true })
    const { boundary, spies } = makeBoundary()
    const input = await buildPunchInput(seed)
    const result = await boundary.executeLivePunch(input)

    expect(result.kind).toBe('w4')
    const calcs = await calcRows(seed.userId)
    // Exactly one row, and it is the authoritative calculation — never a baseline. A baseline
    // here would mean the placeholder shipped `active` and tripped the core's baseline predicate.
    expect(calcs.length).toBe(1)
    expect(calcs[0].calculation_kind).toBe('calculation')
    expect(calcs.some((row) => row.calculation_kind === 'legacy_baseline')).toBe(false)
    expect(calcs[0].mode).toBe('authoritative')
    expect(calcs[0].outcome).toBe('completed')
    expect(calcs[0].projection_effect).toBe('set_active')
    expect(calcs[0].supersedes_calculation_id).toBeNull()

    // Placeholder created, then promoted by the core's own tail pointer UPDATE — one atomic step.
    const parent = await parentRow(seed.userId)
    expect(parent?.projection_owner).toBe('w4')
    expect(parent?.visibility_state).toBe('active')
    expect(parent?.visibility_reason).toBe('active')
    expect(parent?.current_calculation_id).toBe(calcs[0].id)

    // P-A: the shadow legacy adapter was never invoked; the split seam was, exactly once.
    expect(spies.applyLivePunchLegacy).toBe(0)
    expect(spies.insertLivePunchEvent).toBe(1)
  })

  // =========================================================================
  // F6 review path, absent parent (leg 1) + outbox (§6.2 pinned as-is).
  // =========================================================================

  it('leg 1: fresh REVIEW with an absent parent leaves the placeholder retired/review_placeholder with a NULL pointer, zero children, and emits exactly one attendance.punched row', async () => {
    // No shift => the freeze step cannot build a resolved_v2 attribution => review_required.
    const seed = await seedAuthoritativeOrg('g1')
    const { boundary, spies } = makeBoundary()
    const result = await boundary.executeLivePunch(await buildPunchInput(seed))
    expect(result.kind).toBe('w4')

    const calcs = await calcRows(seed.userId)
    expect(calcs.length).toBe(1)
    expect(calcs[0].outcome).toBe('review_required')
    expect(calcs[0].projection_effect).toBe('none')
    expect(calcs[0].expected_segment_count).toBe(0)
    expect(calcs[0].projected_status).toBeNull()
    expect(calcs[0].projected_daily_fingerprint).toBeNull()
    expect(calcs[0].supersedes_calculation_id).toBeNull()
    expect(await segmentCount(String(calcs[0].id))).toBe(0)

    const parent = await parentRow(seed.userId)
    expect(parent?.projection_owner).toBe('legacy_untracked')
    expect(parent?.current_calculation_id).toBeNull()
    expect(parent?.visibility_state).toBe('retired')
    expect(parent?.visibility_reason).toBe('review_placeholder')

    // §6.2 pinned AS-IS: the enqueue is unconditional, exactly as on the shadow path today.
    const outbox = await outboxRows(seed.orgId)
    expect(outbox.length).toBe(1)
    expect(outbox[0].event_kind).toBe('attendance.punched')
    expect(spies.applyLivePunchLegacy).toBe(0)
  })

  // =========================================================================
  // Legacy-active parent: baseline + canonical compat fingerprint (leg 3) and review (leg 4).
  // =========================================================================

  it('leg 3: COMPLETED over a legacy-ACTIVE parent appends exactly one legacy_baseline whose stored projected_daily_fingerprint EQUALS a canonical recompute (byte identity)', async () => {
    const seed = await seedAuthoritativeOrg('g3', { withShift: true })
    const input = await buildPunchInput(seed)
    const recordId = await insertLegacyActiveParent(seed.orgId, seed.userId, input.workDate)
    // The exact pre-authoritative parent state, read back the way the boundary reads it.
    const before = (await pool.query(
      `SELECT status, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes
         FROM attendance_records WHERE id = $1::uuid`,
      [recordId],
    )).rows[0]

    const { boundary } = makeBoundary()
    const result = await boundary.executeLivePunch(input)
    expect(result.kind).toBe('w4')

    const calcs = await calcRows(seed.userId)
    const baselines = calcs.filter((row) => row.calculation_kind === 'legacy_baseline')
    const calculations = calcs.filter((row) => row.calculation_kind === 'calculation')
    expect(baselines.length).toBe(1)
    expect(calculations.length).toBe(1)
    expect(calculations[0].supersedes_calculation_id).toBe(baselines[0].id)
    expect(Number(baselines[0].version)).toBeLessThan(Number(calculations[0].version))

    // BYTE IDENTITY: the stored fingerprint is what the CANONICAL producer yields over that exact
    // pre-authoritative state — not a hand-rolled fifth copy, and not the ops-retirement digest.
    const recomputed = computeAttendanceImportRollbackPreimageFingerprintV1({
      projection: {
        status: String(before.status),
        firstInAt: before.first_in_at === null ? null : new Date(before.first_in_at as string | Date).toISOString(),
        lastOutAt: before.last_out_at === null ? null : new Date(before.last_out_at as string | Date).toISOString(),
        workMinutes: Number(before.work_minutes),
        lateMinutes: Number(before.late_minutes),
        earlyLeaveMinutes: Number(before.early_leave_minutes),
      },
      projectionOwner: 'legacy_untracked',
      currentCalculationId: null,
      visibilityState: 'active',
      visibilityReason: 'active',
    })
    expect(baselines[0].projected_daily_fingerprint).toBe(recomputed)

    const parent = await parentRow(seed.userId)
    expect(parent?.projection_owner).toBe('w4')
    expect(parent?.visibility_state).toBe('active')
    expect(parent?.current_calculation_id).toBe(calculations[0].id)
  })

  it('leg 4: REVIEW over a legacy-ACTIVE parent leaves owner/pointer/visibility and all six legacy daily columns BIT-IDENTICAL, while the review calc row exists in history', async () => {
    // No shift => review outcome, but a real legacy-active parent is present.
    const seed = await seedAuthoritativeOrg('g4')
    const input = await buildPunchInput(seed)
    const recordId = await insertLegacyActiveParent(seed.orgId, seed.userId, input.workDate)
    const snapshot = async () => (await pool.query(
      `SELECT status, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes,
              projection_owner, current_calculation_id, visibility_state, visibility_reason
         FROM attendance_records WHERE id = $1::uuid`,
      [recordId],
    )).rows[0]
    const before = await snapshot()

    const { boundary } = makeBoundary()
    const result = await boundary.executeLivePunch(input)
    expect(result.kind).toBe('w4')
    expect(await snapshot()).toEqual(before)

    const calcs = await calcRows(seed.userId)
    expect(calcs.length).toBe(1)
    expect(calcs[0].outcome).toBe('review_required')
    expect(calcs[0].projection_effect).toBe('none')
  })

  // =========================================================================
  // identityDrift override (leg 5).
  // =========================================================================

  it('leg 5: identity drift (a mismatched OUTER source-definition fingerprint) forces REVIEW with no pointer move — negative control: the identical punch WITHOUT drift completes and moves the pointer', async () => {
    const drifted = await seedAuthoritativeOrg('g5a', { withShift: true })
    const driftInput = await buildPunchInput(drifted, {
      outerSourceDefinitionFingerprint: 'f'.repeat(64),
    })
    const { boundary: b1 } = makeBoundary()
    expect((await b1.executeLivePunch(driftInput)).kind).toBe('w4')
    const driftCalcs = await calcRows(drifted.userId)
    expect(driftCalcs.length).toBe(1)
    expect(driftCalcs[0].outcome).toBe('review_required')
    expect(driftCalcs[0].outcome_reason_code).toBe('context_mismatch')
    expect((await parentRow(drifted.userId))?.current_calculation_id).toBeNull()

    // NEGATIVE CONTROL — same fixture shape, real outer fingerprint.
    const clean = await seedAuthoritativeOrg('g5b', { withShift: true })
    const { boundary: b2 } = makeBoundary()
    expect((await b2.executeLivePunch(await buildPunchInput(clean))).kind).toBe('w4')
    const cleanCalcs = await calcRows(clean.userId)
    expect(cleanCalcs.filter((r) => r.calculation_kind === 'calculation')[0].outcome).toBe('completed')
    expect((await parentRow(clean.userId))?.current_calculation_id).not.toBeNull()
  })

  // =========================================================================
  // payloadFingerprint embedding + retry idempotency (leg 6) and seal equality (leg 7).
  // =========================================================================

  it('leg 6: a retry with the SAME operationId returns kind:replay with the same calculationId (NOT REPLAY_CONFLICT), and the persisted input_provenance carries the payloadFingerprint the core reads back', async () => {
    const seed = await seedAuthoritativeOrg('g6', { withShift: true })
    const input = await buildPunchInput(seed)
    const { boundary } = makeBoundary()
    const first = await boundary.executeLivePunch(input)
    expect(first.kind).toBe('w4')
    const before = await calcRows(seed.userId)

    const second = await boundary.executeLivePunch(input)
    // The registry preflight itself recognises the completed operation and replays it.
    expect(second.kind).toBe('replay')
    expect((await calcRows(seed.userId)).length).toBe(before.length)

    // The embedded copy is what makes the CORE's own `retryReplayLookup` return a replay instead
    // of REPLAY_CONFLICT: it reads `input_provenance.payloadFingerprint` verbatim off the row.
    const calc = before.filter((r) => r.calculation_kind === 'calculation')[0]
    const provenance = calc.input_provenance as Record<string, unknown>
    expect(typeof provenance.payloadFingerprint).toBe('string')
    expect((provenance.payloadFingerprint as string).length).toBe(64)
  })

  it('leg 7 [MANDATORY]: the sealed resultSemanticFingerprint EQUALS the persisted semantic_input_fingerprint on the authoritative calc row (guards the boundary-recomputed tier arg)', async () => {
    const seed = await seedAuthoritativeOrg('g7', { withShift: true })
    const { boundary } = makeBoundary()
    expect((await boundary.executeLivePunch(await buildPunchInput(seed))).kind).toBe('w4')
    const calc = (await calcRows(seed.userId)).filter((r) => r.calculation_kind === 'calculation')[0]
    const ops = await operationRows(seed.orgId)
    expect(ops.length).toBe(1)
    expect(ops[0].resolved_calculation_id).toBe(calc.id)
    // A `legacy_shadow` tier arg here would seal a DIFFERENT digest than the row carries.
    expect(ops[0].result_semantic_fingerprint).toBe(calc.semantic_input_fingerprint)
  })

  // =========================================================================
  // Read-side invisibility (leg 8) and VERSION_CONFLICT (leg 9).
  // =========================================================================

  it('leg 8: a review_placeholder parent is invisible through the CANONICAL active-current helper (the singular host-port read every ordinary surface goes through) while the immutable review calc row remains readable in history', async () => {
    const seed = await seedAuthoritativeOrg('g8')
    const { boundary } = makeBoundary()
    const input = await buildPunchInput(seed)
    expect((await boundary.executeLivePunch(input)).kind).toBe('w4')

    // Driven through `w4c3c-active-current`'s own exported helper, NOT a hand-written
    // `visibility_state = 'active'` filter: asserting that a filter this test wrote filters is a
    // tautology. This is the P20 singular helper the plugin's ordinary read surfaces resolve
    // through, so a miss here is a miss for those surfaces.
    const client = await pool.connect()
    try {
      const hidden = await loadActiveCurrentAttendanceRecordForDecisionTraceV1(
        async (sqlText: string, params?: readonly unknown[]) =>
          client.query(sqlText, (params ?? []) as unknown[]),
        { orgId: seed.orgId, userId: seed.userId, workDate: input.workDate },
      )
      expect(hidden).toBeNull()
      // POSITIVE CONTROL — the same helper DOES return a promoted (completed) parent, so the null
      // above is the placeholder being hidden, not the helper being broken or mis-keyed.
      const promotedSeed = await seedAuthoritativeOrg('g8-control', { withShift: true })
      const promotedInput = await buildPunchInput(promotedSeed)
      const { boundary: control } = makeBoundary()
      expect((await control.executeLivePunch(promotedInput)).kind).toBe('w4')
      const visible = await loadActiveCurrentAttendanceRecordForDecisionTraceV1(
        async (sqlText: string, params?: readonly unknown[]) =>
          client.query(sqlText, (params ?? []) as unknown[]),
        { orgId: promotedSeed.orgId, userId: promotedSeed.userId, workDate: promotedInput.workDate },
      )
      expect(visible).not.toBeNull()
    } finally {
      client.release()
    }
    expect((await calcRows(seed.userId)).length).toBe(1)
  })

  it('leg 9: `expectedCurrentCalculationId` is sourced from the LOCKED read, so a second authoritative punch supersedes the moved pointer instead of failing VERSION_CONFLICT', async () => {
    // NOT a VERSION_CONFLICT leg: the boundary holds the parent `FOR UPDATE` from its own read
    // through commit, so no writer can move the pointer in between and the 409 is unreachable
    // from here by construction (the core's own stale-expectation refusal is proven at the core
    // seam, in the D1 suite). What IS provable here — and is the §5.4 obligation — is that the
    // expectation comes from that locked read rather than being assumed `null`: hardcoding it to
    // `null` makes the SECOND punch below 409 instead of superseding.
    const seed = await seedAuthoritativeOrg('g9', { withShift: true })
    const { boundary } = makeBoundary()
    expect((await boundary.executeLivePunch(await buildPunchInput(seed))).kind).toBe('w4')
    const parent = await parentRow(seed.userId)
    expect(parent?.current_calculation_id).not.toBeNull()

    // A second, DIFFERENT punch now reads the moved pointer and supersedes it — proving the
    // expectation is sourced from the LOCKED read, not assumed null (which would 409).
    const second = await boundary.executeLivePunch(
      await buildPunchInput(seed, { occurredAtResolved: '2026-05-04T09:30:00.000Z', eventType: 'check_out' }),
    )
    expect(second.kind).toBe('w4')
    const calcs = (await calcRows(seed.userId)).filter((r) => r.calculation_kind === 'calculation')
    expect(calcs.length).toBe(2)
    expect(calcs[1].supersedes_calculation_id).toBe(calcs[0].id)
  })

  // =========================================================================
  // Wire response (legs 10, 10b, 10c) and the P-A pin (leg 11b).
  // =========================================================================

  it('leg 10: the caller response carries event + record + workDateResolution for BOTH outcomes, and the sealed responseSnapshot equals wireJson(response)', async () => {
    for (const withShift of [true, false]) {
      const seed = await seedAuthoritativeOrg(`g10-${String(withShift)}`, { withShift })
      const { boundary } = makeBoundary()
      const result = await boundary.executeLivePunch(await buildPunchInput(seed))
      expect(result.kind).toBe('w4')
      const response = (result as { response: Record<string, unknown> }).response
      expect(response.event).toBeTruthy()
      expect(response.record).toBeTruthy()
      expect(response.workDateResolution).toBeTruthy()
      const ops = await operationRows(seed.orgId)
      expect(ops.length).toBe(1)
      expect(ops[0].response_snapshot).toEqual(JSON.parse(JSON.stringify(response)))
    }
  })

  it('leg 10b: an authoritative punch writes EXACTLY ONE attendance_events row and the calculation sees it — a day FIRST check-in yields a segment whose actualInAt is populated', async () => {
    const seed = await seedAuthoritativeOrg('g10b', { withShift: true })
    const { boundary, spies } = makeBoundary()
    expect((await boundary.executeLivePunch(await buildPunchInput(seed))).kind).toBe('w4')
    expect(await eventCount(seed.userId)).toBe(1)
    expect(spies.insertLivePunchEvent).toBe(1)

    const calc = (await calcRows(seed.userId)).filter((r) => r.calculation_kind === 'calculation')[0]
    expect(calc.outcome).toBe('completed')
    // The DISCRIMINATOR is segment CONTENT, not the outcome field: had the split dropped the
    // event INSERT, the evidence set would be empty and `actual_in_at` would be NULL.
    const segments = await pool.query(
      `SELECT actual_in_at FROM attendance_record_segments WHERE calculation_id = $1::uuid ORDER BY segment_index`,
      [calc.id],
    )
    expect(segments.rows.length).toBeGreaterThan(0)
    expect(segments.rows[0].actual_in_at).not.toBeNull()
  })

  /**
   * The exact `attendance_records` COLUMN set the public punch contract's `record` carries — the
   * snake_case DB-row shape, spelled once so the completed, review and legacy-parity assertions
   * below cannot drift apart independently. It is NOT the authority: leg 10e recomputes the same
   * set from a REAL legacy punch response produced in the same run and asserts equality, so a
   * writer that drifts cannot be "fixed" by editing this list.
   */
  const ATTENDANCE_RECORD_ROW_KEYS_V1 = [
    'created_at',
    'current_calculation_id',
    'early_leave_minutes',
    'first_in_at',
    'id',
    'is_workday',
    'last_out_at',
    'late_minutes',
    'meta',
    'org_id',
    'projection_owner',
    'source_batch_id',
    'status',
    'timezone',
    'updated_at',
    'user_id',
    'visibility_reason',
    'visibility_state',
    'work_date',
    'work_minutes',
  ]

  /** The camelCase members the RETRACTED mapped-projection shape carried. None may appear. */
  const RETRACTED_MAPPED_PROJECTION_KEYS_V1 = [
    'workedMinutes', 'firstInAt', 'lastOutAt', 'lateMinutes', 'earlyLeaveMinutes', 'workDate',
  ]

  it('leg 10c [CONTRACT]: the COMPLETED-case `record` is the persisted snake_case attendance_records ROW — the published AttendanceRecord contract — carrying the AUTHORITATIVE values, and no camelCase member of the retracted mapped shape', async () => {
    const seed = await seedAuthoritativeOrg('g10c', { withShift: true })
    const { boundary } = makeBoundary()
    const result = await boundary.executeLivePunch(await buildPunchInput(seed))
    const record = ((result as { response: Record<string, unknown> }).response.record) as Record<string, unknown>

    // Full DB-row column set, snake_case — NOT a nine-field camelCase projection.
    expect(Object.keys(record).sort()).toEqual(ATTENDANCE_RECORD_ROW_KEYS_V1)
    // Regression guard for the retracted shape specifically: asserting the ABSENCE of its
    // members is what discriminates between the two candidate contracts, not just typos.
    for (const retracted of RETRACTED_MAPPED_PROJECTION_KEYS_V1) {
      expect(Object.prototype.hasOwnProperty.call(record, retracted)).toBe(false)
    }

    // It is the REAL persisted row the core just wrote, not a re-serialisation of the
    // calculation: the promoted pointer/owner/visibility are on it, and the daily values are the
    // AUTHORITATIVE ones (only the VALUES differ from a legacy punch, never the shape).
    const parent = await parentRow(seed.userId)
    expect(record.id).toBe(parent?.id)
    expect(record.projection_owner).toBe('w4')
    expect(record.visibility_state).toBe('active')
    expect(record.current_calculation_id).toBe(parent?.current_calculation_id)
    const calc = (await calcRows(seed.userId)).filter((r) => r.calculation_kind === 'calculation')[0]
    expect(calc.outcome).toBe('completed')
    expect(record.status).toBe(calc.projected_status)
  })

  it('leg 10d [CONTRACT]: the REVIEW-case `record` is the persisted PLACEHOLDER row in the SAME snake_case column set — a real row, never a synthesized all-NULL acknowledgement', async () => {
    const seed = await seedAuthoritativeOrg('g10d')  // no shift => attribution unsupported => review
    const { boundary } = makeBoundary()
    const result = await boundary.executeLivePunch(await buildPunchInput(seed))
    expect(result.kind).toBe('w4')
    // Assert the outcome really is REVIEW, so this leg cannot silently become a second completed
    // leg if the no-shift fixture ever starts resolving.
    const calcs = await calcRows(seed.userId)
    expect(calcs.length).toBe(1)
    expect(calcs[0].outcome).toBe('review_required')

    const record = ((result as { response: Record<string, unknown> }).response.record) as Record<string, unknown>
    // SAME column set as the completed case — the shape does not change between outcomes.
    expect(Object.keys(record).sort()).toEqual(ATTENDANCE_RECORD_ROW_KEYS_V1)
    for (const retracted of RETRACTED_MAPPED_PROJECTION_KEYS_V1) {
      expect(Object.prototype.hasOwnProperty.call(record, retracted)).toBe(false)
    }
    // ...and it is the PERSISTED placeholder, echoed truthfully: still retired, still unpointed.
    const parent = await parentRow(seed.userId)
    expect(record.id).toBe(parent?.id)
    expect(record.projection_owner).toBe('legacy_untracked')
    expect(record.current_calculation_id).toBeNull()
    expect(record.visibility_state).toBe('retired')
    expect(record.visibility_reason).toBe('review_placeholder')
  })

  it('leg 10e [CONTRACT PARITY]: an AUTHORITATIVE punch response is SHAPE-IDENTICAL to a real LEGACY punch response — for BOTH the unresolved AND the resolved `workDateResolution` branch; only the VALUES differ', async () => {
    // The owner ruling this leg enforces: tests only FREEZE a shape, they do not APPROVE it. So
    // the authoritative response is compared against a REAL legacy response computed in this same
    // run - not against a hand-copied key list that could be edited to match a drifting writer.
    //
    // BOTH resolution branches are compared, and that is load-bearing rather than thorough-for-
    // its-own-sake. The legacy `workDateResolution` object's key set legitimately differs between
    // its resolved and unresolved branches, so each side must be compared against its own
    // counterpart. More importantly: an UNRESOLVED-only comparison is BLIND to the substitution
    // this leg exists to catch. The boundary's freeze-step resolver opts into `includeFullWinner`,
    // which adds a `fullWinner` member ONLY when a winner actually resolves - so swapping that
    // object in for the legacy derivation leaves the unresolved shapes identical and reds nothing.
    // Measured, not assumed: with only the unresolved pair, that exact substitution passed.
    for (const withShift of [false, true]) {
      const label = withShift ? 'resolved' : 'unresolved'

      // --- a REAL legacy punch (org deliberately not allowlisted => legacy posture) ---
      const legacyOrg = uuid()
      const legacyUser = uuid()
      await insertActiveUser(legacyUser, legacyOrg)
      if (withShift) await insertShiftAndAssignment(legacyOrg, legacyUser)
      const { boundary: legacyBoundary, spies: legacySpies } = makeBoundary()
      const legacyResult = await legacyBoundary.executeLivePunch(
        await buildPunchInput({ orgId: legacyOrg, userId: legacyUser }),
      )
      // `legacy_compat`, not `legacy`: `buildPunchInput` always supplies a stable `operationId`,
      // so this takes the stable-ID legacy branch (claim + seal). Same closed adapter, same
      // response bytes - the branch differs only in whether an operation row is written. Pinned
      // exactly rather than accepted as "either legacy kind", so a posture drift reds here too.
      expect(legacyResult.kind).toBe('legacy_compat')
      expect(legacySpies.applyLivePunchLegacy).toBe(1)   // it really was the legacy adapter
      const legacyResponse = (legacyResult as { response: Record<string, unknown> }).response

      // --- the AUTHORITATIVE punch, same fixture shape ---
      const authSeed = await seedAuthoritativeOrg(`g10e-${label}`, { withShift })
      const { boundary: authBoundary } = makeBoundary()
      const authResult = await authBoundary.executeLivePunch(await buildPunchInput(authSeed))
      expect(authResult.kind).toBe('w4')
      const authResponse = (authResult as { response: Record<string, unknown> }).response

      // Top-level contract members.
      expect(Object.keys(authResponse).sort()).toEqual(Object.keys(legacyResponse).sort())

      // `record` and `event`: full column sets, identical. `meta` is a jsonb VALUE whose contents
      // legitimately differ (the legacy path freezes attribution into it; the placeholder does
      // not), so it is compared as a leaf - a field-set-and-casing assertion, not a value one.
      for (const member of ['record', 'event'] as const) {
        const auth = authResponse[member] as Record<string, unknown>
        const legacy = legacyResponse[member] as Record<string, unknown>
        expect(Object.keys(auth).sort()).toEqual(Object.keys(legacy).sort())
      }
      expect(Object.keys(authResponse.record as Record<string, unknown>).sort())
        .toEqual(ATTENDANCE_RECORD_ROW_KEYS_V1)

      // `workDateResolution`: RECURSIVE key-path parity, because a parallel spelling would most
      // likely differ deeper than the top level (the retracted build shipped a flat 5-key
      // projection where the contract carries a nested `evidenceSnapshot`). Same shared
      // instrument the legacy golden-response helper uses.
      expect(recursiveKeyPaths(authResponse.workDateResolution))
        .toEqual(recursiveKeyPaths(legacyResponse.workDateResolution))
      // Non-vacuity: a real nested resolution on both sides, of the KIND this iteration intends
      // (so a fixture that silently stopped resolving cannot turn the resolved half into a second
      // unresolved comparison).
      expect(recursiveKeyPaths(authResponse.workDateResolution).length).toBeGreaterThan(3)
      expect((authResponse.workDateResolution as Record<string, unknown>).kind)
        .toBe(withShift ? 'resolved' : 'unresolved')
      expect((legacyResponse.workDateResolution as Record<string, unknown>).kind)
        .toBe(withShift ? 'resolved' : 'unresolved')

      // ...and the VALUES do differ where they must: the authoritative row carries W4 bookkeeping,
      // the legacy row does not. Shape identical, values authoritative - the whole point.
      const authRecord = authResponse.record as Record<string, unknown>
      const legacyRecord = legacyResponse.record as Record<string, unknown>
      expect(legacyRecord.projection_owner).toBe('legacy_untracked')
      expect(legacyRecord.visibility_state).toBe('active')
      if (withShift) {
        expect(authRecord.projection_owner).toBe('w4')       // promoted by the core
        expect(authRecord.visibility_state).toBe('active')
      } else {
        expect(authRecord.projection_owner).toBe('legacy_untracked')
        expect(authRecord.visibility_state).toBe('retired')  // the review placeholder
      }
    }
  }, 60000)

  it('leg 10f [CONTRACT SEMANTICS]: the echoed `workDateResolution` is derived PRE-write — an OVERNIGHT completed check-in echoes PREVIOUS_NIGHT_CONTAINING_SHIFT, not the OPEN_PREVIOUS_NIGHT_RECORD the same derivation yields once this operation\'s own write exists', async () => {
    // WHY THIS LEG EXISTS. Matching the legacy contract is not only field names and casing - it is
    // SEMANTICS. The legacy path derives `workDateResolution` BEFORE its own `attendance_records`
    // upsert. The resolver consults OPEN records (`w4c3c-active-current.ts:176-190`:
    // `first_in_at IS NOT NULL AND last_out_at IS NULL`, through the `visibility_state='active'`
    // view) as its HIGHEST-precedence tie-break (`selectAmongMatchingCandidates`, resolver
    // `:397-425`). The core's completed-path pointer UPDATE writes exactly that shape for a
    // check-in-only day - `first_in_at` set, `last_out_at` still null - and flips the row to
    // `active`. So a derivation placed after the core call can observe the record THIS operation
    // just created and echo a resolution the legacy path could never produce for the same punch.
    //
    // THE FIXTURE. An overnight shift (22:00 -> 06:00) and a check-in at 01:00 local. That makes
    // the punch's `calendarWorkDate` the NEXT day while the winning candidate's own `workDate` is
    // the previous one - the precise precondition the open-record branch requires
    // (`candidate.workDate < calendarWorkDate && candidate.isOvernight`). Same shift, same work
    // date, DIFFERENT `reasonCode`, plus an extra `openRecordWorkDate` member in the evidence.
    const seed = await seedAuthoritativeOrg('g10f')
    await insertOvernightShiftAndAssignment(seed.orgId, seed.userId)
    // 2026-05-05T01:00 Asia/Shanghai (UTC+8) === 2026-05-04T17:00Z: calendar day 05-05, winning
    // overnight candidate's work date 05-04.
    const occurredAtResolved = '2026-05-04T17:00:00.000Z'

    // (1) The PRE-write value, measured out-of-band before the punch exists at all.
    const before = await deriveWorkDateResolutionOutOfBand(seed, occurredAtResolved)
    expect(before.kind).toBe('resolved')
    expect(before.reasonCode).toBe('PREVIOUS_NIGHT_CONTAINING_SHIFT')

    // (2) The authoritative punch. It must COMPLETE, because only the completed path's pointer
    // UPDATE writes the open record - a review outcome would leave the placeholder retired and
    // this leg would be vacuous.
    const { boundary } = makeBoundary()
    const result = await boundary.executeLivePunch(
      await buildPunchInput(seed, { occurredAtResolved, eventType: 'check_in' }),
    )
    expect(result.kind).toBe('w4')
    const calc = (await calcRows(seed.userId)).filter((r) => r.calculation_kind === 'calculation')[0]
    expect(calc.outcome).toBe('completed')
    const parent = await parentRow(seed.userId)
    expect(parent?.visibility_state).toBe('active')       // visible to the open-records view
    expect(parent?.first_in_at).not.toBeNull()            // ...and it IS an open record now
    expect(parent?.last_out_at).toBeNull()

    // (3) The POST-write value, measured the same way once that row exists. This is the
    // discriminator: it proves the two derivations genuinely DIFFER for this fixture, so the
    // assertion in (4) is not vacuously true.
    const after = await deriveWorkDateResolutionOutOfBand(seed, occurredAtResolved)
    expect(after.kind).toBe('resolved')
    expect(after.reasonCode).toBe('OPEN_PREVIOUS_NIGHT_RECORD')
    expect(after.reasonCode).not.toBe(before.reasonCode)

    // (4) THE ASSERTION: the response echoed the PRE-write value - what legacy would have echoed.
    const echoed = ((result as { response: Record<string, unknown> }).response
      .workDateResolution) as Record<string, unknown>
    expect(echoed.reasonCode).toBe('PREVIOUS_NIGHT_CONTAINING_SHIFT')
    expect(echoed.reasonCode).toBe(before.reasonCode)
    // The identity half is UNCHANGED between the two derivations, which is exactly why a
    // reasonCode-only assertion is the discriminating one here.
    expect(echoed.workDate).toBe(before.workDate)
    expect(echoed.shiftId).toBe(before.shiftId)
    // Structural tell: the open-record branch adds `openRecordWorkDate` to its evidence snapshot.
    // Its ABSENCE is a second, independent discriminator that does not rely on the reason string.
    const evidence = echoed.evidenceSnapshot as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(evidence, 'openRecordWorkDate')).toBe(false)
    expect(
      Object.prototype.hasOwnProperty.call(after.evidenceSnapshot as Record<string, unknown>, 'openRecordWorkDate'),
    ).toBe(true)
  }, 60000)

  it('leg 11b [the real P-A pin]: an AUTHORITATIVE punch invokes the injected applyLivePunchLegacy ZERO times — negative control: a SHADOW punch invokes it exactly once', async () => {
    const authoritative = await seedAuthoritativeOrg('g11b-auth', { withShift: true })
    const { boundary: authBoundary, spies: authSpies } = makeBoundary()
    expect((await authBoundary.executeLivePunch(await buildPunchInput(authoritative))).kind).toBe('w4')
    expect(authSpies.applyLivePunchLegacy).toBe(0)

    // NEGATIVE CONTROL: the same driver, a shadow-postured org.
    const shadowOrg = allow(uuid())
    const shadowUser = uuid()
    await insertActiveUser(shadowUser, shadowOrg)
    await insertRolloutState(shadowOrg, 'shadow')
    await insertShiftAndAssignment(shadowOrg, shadowUser)
    const { boundary: shadowBoundary, spies: shadowSpies } = makeBoundary()
    const shadowResult = await shadowBoundary.executeLivePunch(
      await buildPunchInput({ orgId: shadowOrg, userId: shadowUser }),
    )
    expect(shadowResult.kind).toBe('w4')
    expect(shadowSpies.applyLivePunchLegacy).toBe(1)
    expect(shadowSpies.insertLivePunchEvent).toBe(0)
  })

  // =========================================================================
  // Retirement guard (legs 12a, 12b).
  // =========================================================================

  /**
   * Retires a LEGACY-untracked parent with `import_rollback`. `operator_retirement` is NOT
   * installable this way — `attendance_w4_records_pointer_guard` refuses a `legacy_untracked`
   * parent carrying that reason ("operator retirement requires a W4 pointer") — which is why
   * leg 12a below builds its fixture through the core's own reversal writer instead of a
   * hand-written UPDATE. Fabricating an impossible row would have made that leg vacuous.
   */
  async function retireParent(recordId: string, reason: 'import_rollback'): Promise<void> {
    await pool.query(
      `UPDATE attendance_records SET visibility_state = 'retired', visibility_reason = $2 WHERE id = $1::uuid`,
      [recordId, reason],
    )
  }

  it('leg 12a: an authoritative punch on a genuinely operator_retirement-retired parent is REFUSED with ATTENDANCE_RECORD_OPERATOR_RETIRED (409), zero writes, and the parent is bit-identical before/after', async () => {
    const seed = await seedAuthoritativeOrg('g12a', { withShift: true })
    const input = await buildPunchInput(seed)
    // Build the retired parent the way production does: an authoritative completed punch takes
    // ownership of the day, then the core's own reversal writer retires it with
    // `operator_retirement`. The DB pointer guard validates this end to end (pointer target must
    // be an authoritative reversed row with effect set_retired, reason operator_retirement, and
    // the parent's daily fields must equal its snapshot), so the fixture is a real row, not a
    // hand-written state the schema would never produce.
    const { boundary: seedBoundary } = makeBoundary()
    expect((await seedBoundary.executeLivePunch(input)).kind).toBe('w4')
    const promoted = await parentRow(seed.userId)
    const recordId = String(promoted?.id)
    const pointer = String(promoted?.current_calculation_id)
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
        orgId: seed.orgId,
        recordId,
        entrypoint: 'ops_retirement',
        operationId: uuid(),
        supersedesCalculationId: pointer,
        reversedSnapshots: {
          semanticInputFingerprint: 'a'.repeat(64),
          provenanceFingerprint: 'a'.repeat(64),
          // `chk_arc_context_nullability` / `chk_arc_source_def_nullability` allow NULL only for a
          // review outcome; a reversal carries the reversed row's own snapshots forward.
          sourceDefinitionFingerprint: 'a'.repeat(64),
          attributionSnapshot: { posture: 'unsupported', sourceSchemaVersion: 1, reason: 'legacy_v1', sourceFingerprint: null },
          contextSnapshot: { schemaVersion: 1, kind: 'w4c2_d2_fixture_context' },
          evidenceSnapshot: [],
          approvedFactsSnapshot: [],
          manualOverrideSnapshot: null,
        },
        inputProvenance: { schemaVersion: 1, kind: 'w4c2_d2_fixture' },
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
        actorId: `actor-${RUN}`,
        correlationId: `corr-${RUN}`,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    // The fixture is REAL: assert the row actually reached the state under test rather than
    // trusting the write, so a silently-skipped retirement cannot make this leg vacuous.
    const retired = await parentRow(seed.userId)
    expect(retired?.visibility_state).toBe('retired')
    expect(retired?.visibility_reason).toBe('operator_retirement')

    const eventsBefore = await eventCount(seed.userId)
    const calcsBefore = (await calcRows(seed.userId)).length
    const snapshot = async () => (await pool.query(
      `SELECT status, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes,
              projection_owner, current_calculation_id, visibility_state, visibility_reason
         FROM attendance_records WHERE id = $1::uuid`,
      [recordId],
    )).rows[0]
    const before = await snapshot()

    const { boundary, spies } = makeBoundary()
    // A FRESH operation id, so this is a genuine new punch rather than a registry replay.
    await expect(
      boundary.executeLivePunch(await buildPunchInput(seed, { occurredAtResolved: '2026-05-04T02:15:00.000Z' })),
    ).rejects.toMatchObject({ code: 'ATTENDANCE_RECORD_OPERATOR_RETIRED' })
    // No reactivation: owner/pointer/visibility/reason and all six daily columns bit-identical.
    expect(await snapshot()).toEqual(before)
    // Zero writes: the guard fires BEFORE the split event INSERT and before the core call.
    expect(await eventCount(seed.userId)).toBe(eventsBefore)
    expect((await calcRows(seed.userId)).length).toBe(calcsBefore)
    expect(spies.insertLivePunchEvent).toBe(0)
    expect(spies.applyLivePunchLegacy).toBe(0)
  })

  it('leg 12b: an authoritative punch on an import_rollback-retired parent is REFUSED with ATTENDANCE_RECORD_RETIRED (409) — never a bare completed that reactivates it', async () => {
    const seed = await seedAuthoritativeOrg('g12b', { withShift: true })
    const input = await buildPunchInput(seed)
    const recordId = await insertLegacyActiveParent(seed.orgId, seed.userId, input.workDate)
    await retireParent(recordId, 'import_rollback')
    const snapshot = async () => (await pool.query(
      `SELECT projection_owner, current_calculation_id, visibility_state, visibility_reason
         FROM attendance_records WHERE id = $1::uuid`,
      [recordId],
    )).rows[0]
    const before = await snapshot()

    const { boundary, spies } = makeBoundary()
    await expect(boundary.executeLivePunch(input)).rejects.toMatchObject({
      code: 'ATTENDANCE_RECORD_RETIRED',
    })
    // No `core:889-892` reactivation, and no source DML at all.
    expect(await snapshot()).toEqual(before)
    expect(await eventCount(seed.userId)).toBe(0)
    expect((await calcRows(seed.userId)).length).toBe(0)
    expect(spies.insertLivePunchEvent).toBe(0)
  })

  // =========================================================================
  // Concurrency (legs 13a, 13b).
  // =========================================================================

  it('leg 13a: the boundary parent FOR UPDATE holds through commit — a concurrent writer on the same parent row BLOCKS until the authoritative transaction commits (serialized, no interleave)', async () => {
    const seed = await seedAuthoritativeOrg('g13a', { withShift: true })
    const input = await buildPunchInput(seed)
    const recordId = await insertLegacyActiveParent(seed.orgId, seed.userId, input.workDate)

    const blocker: PoolClient = await pool.connect()
    // Hold the row lock from the OTHER side first, so the boundary transaction is the one that
    // must wait — a settle-race-free construction (we observe the boundary NOT settling).
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM attendance_records WHERE id = $1::uuid FOR UPDATE', [recordId])

    const { boundary } = makeBoundary()
    const pending = boundary.executeLivePunch(input)
    const marker = { settled: false }
    pending.then(() => { marker.settled = true }, () => { marker.settled = true })
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(marker.settled).toBe(false) // genuinely blocked on the row lock, not merely slow

    await blocker.query('ROLLBACK').catch(() => undefined)
    blocker.release()
    const result = await pending
    expect(result.kind).toBe('w4')
  }, 30000)

  it('leg 13b: a CONSTRUCTED two-connection race on the create-if-absent placeholder INSERT resolves to a PRODUCT outcome — the loser gets zero rows back, never a raw 23505 that poisons its transaction', async () => {
    // Driven at the exported seam ON PURPOSE. Through the boundary this race is already prevented
    // one layer up by the class-11 advisory target lock (see leg 13c), so a boundary-level
    // "concurrent punch" fixture CANNOT exercise the ON CONFLICT clause — removing the clause
    // leaves such a leg green, which is exactly how an ineffective mutation masquerades as a
    // passing test. This leg constructs the real interleave the clause exists for.
    const seed = await seedAuthoritativeOrg('g13b-seam')
    const workDate = '2026-05-06'
    const a: PoolClient = await pool.connect()
    const b: PoolClient = await pool.connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      const args = {
        orgId: seed.orgId,
        userId: seed.userId,
        workDate,
        timezone: TZ,
        isWorkday: true,
      }
      const first = await insertAuthoritativeReviewPlaceholderParentV1(
        a as unknown as AttendanceW4TransactionClientV1,
        args,
      )
      expect(first.created).toBe(true)

      // B now races the SAME key while A is uncommitted: it blocks on the unique index.
      const bPromise = insertAuthoritativeReviewPlaceholderParentV1(
        b as unknown as AttendanceW4TransactionClientV1,
        args,
      )
      const marker = { settled: false }
      bPromise.then(() => { marker.settled = true }, () => { marker.settled = true })
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(marker.settled).toBe(false) // genuinely blocked — the race is real, not sequential

      await a.query('COMMIT')
      const second = await bPromise
      // The PRODUCT outcome: zero rows returned, no error. A bare INSERT would have raised 23505
      // and poisoned B's transaction, making the follow-up query below fail with 25P02.
      expect(second.created).toBe(false)
      const stillUsable = await b.query('SELECT 1 AS ok')
      expect(stillUsable.rows[0].ok).toBe(1)
      await b.query('COMMIT')
    } finally {
      await a.query('ROLLBACK').catch(() => undefined)
      await b.query('ROLLBACK').catch(() => undefined)
      a.release()
      b.release()
    }
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_records WHERE user_id = $1 AND work_date = $2::date',
      [seed.userId, workDate],
    )
    expect(rows[0].n).toBe(1)
  }, 30000)

  it('leg 13c: two concurrent authoritative punches for the SAME day serialize on the class-11 advisory target lock — one parent row, two calculations, and the loser re-enters the full resolution path rather than assuming it created the placeholder', async () => {
    const seed = await seedAuthoritativeOrg('g13b', { withShift: true })
    const inputA = await buildPunchInput(seed)
    const inputB = await buildPunchInput(seed, { occurredAtResolved: '2026-05-04T01:07:00.000Z' })
    const { boundary: bA } = makeBoundary()
    const { boundary: bB } = makeBoundary()
    // Genuinely concurrent: both open their own transaction and both find no parent initially.
    const [a, b] = await Promise.all([bA.executeLivePunch(inputA), bB.executeLivePunch(inputB)])
    expect(a.kind).toBe('w4')
    expect(b.kind).toBe('w4')
    // Exactly ONE parent row for the day — the loser re-read under the lock and re-entered.
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_records WHERE user_id = $1 AND work_date = $2::date',
      [seed.userId, inputA.workDate],
    )
    expect(rows[0].n).toBe(1)
    expect((await calcRows(seed.userId)).filter((r) => r.calculation_kind === 'calculation').length).toBe(2)
  }, 30000)

  // =========================================================================
  // legacyOnlyTime reject (leg 14).
  // =========================================================================

  it('leg 14: a legacy-only business time on the AUTHORITATIVE path is rejected with W4_ATTRIBUTION_UNSUPPORTED and ZERO event/record/calc/outbox DML — negative control: a strict instant completes and moves the pointer', async () => {
    const seed = await seedAuthoritativeOrg('g14', { withShift: true })
    const { boundary, spies } = makeBoundary()
    const rejected = await buildPunchInput(seed, { occurredAtRaw: '2026-05-04 09:05:00' })
    await expect(boundary.executeLivePunch(rejected)).rejects.toMatchObject({
      code: 'W4_ATTRIBUTION_UNSUPPORTED',
    })
    expect(await eventCount(seed.userId)).toBe(0)
    expect(await parentRow(seed.userId)).toBeUndefined()
    expect((await calcRows(seed.userId)).length).toBe(0)
    // The reject precedes the enqueue, so no `attendance.punched` row exists either.
    expect((await outboxRows(seed.orgId)).length).toBe(0)
    expect(spies.insertLivePunchEvent).toBe(0)
    expect(spies.applyLivePunchLegacy).toBe(0)

    // NEGATIVE CONTROL on the SAME org/user: a strict instant writes.
    const accepted = await buildPunchInput(seed)
    expect((await boundary.executeLivePunch(accepted)).kind).toBe('w4')
    expect(await eventCount(seed.userId)).toBe(1)
    expect((await parentRow(seed.userId))?.current_calculation_id).not.toBeNull()
    expect((await outboxRows(seed.orgId)).length).toBe(1)
  })
})
