/**
 * W4C-2 (#4556 lock §12.3) — Stage E residual gate matrix (real DB, real
 * MetaSheetServer + plugin activate, route-level plus targeted module-level
 * protocol legs against the same database).
 *
 * §12.3 gate -> leg mapping (this file):
 *
 *  1. "fresh W2 ambiguity creates no parent/result; existing parent may append
 *     only unsupported review with zero children/no pointer" — live leg: two
 *     overlapping published assignments are refused by the PRESERVED legacy
 *     route contract (R5/OD-4556-8 closed 422 `WORK_DATE_ATTRIBUTION_AMBIGUOUS`
 *     — never a silent work-date pick) with ZERO event/record/operation/
 *     calculation/outbox rows: fresh live W2 ambiguity structurally cannot
 *     create a parent or result under effective shadow, because the refusal
 *     precedes the boundary. The "existing parent appends ONLY an unsupported
 *     review with zero children/no pointer" half is exercised through the
 *     reachable unsupported flavor (`missing_frozen_context`, posture-matrix
 *     suite + this file's leg 9 scheduled review) plus the calculator's pinned
 *     closed mapping `ambiguous -> context_resolution_ambiguous`
 *     (w4c1-segment-calculator.test.ts) and the review-shape CHECKs (E1); the
 *     no-pointer invariant is asserted here on leg 9's scheduled review parent.
 *     A single-assignment user on the same org is the in-suite positive
 *     control (completed/calculated), so the refusal is discriminating, not
 *     vacuous. Scheduled leg (leg 9): the ambiguous user is excluded from the
 *     run and gets NO record/operation/calculation at all.
 *  2. "V1/missing/ambiguous/unresolved cannot cast to V2" — behavioral half is
 *     leg 1 (ambiguous => posture 'unsupported', never a fabricated V2; the
 *     pure-builder refusals live in w4c2-frozen-attribution.test.ts); storage
 *     half here: a direct INSERT of a completed calculation whose attribution
 *     posture is not 'resolved_v2' is CHECK-rejected (chk_arc_completed_shape).
 *  3. "same-org other-user and cross-org isolation" — the same operation key
 *     from a DIFFERENT actor in the same org is a closed 409 with zero DML;
 *     the same key in ANOTHER org is an independent operation (PK is
 *     (org, entrypoint, operation_id)) and neither org observes the other.
 *  4. "live operationId response-loss/network/outdoor-note retry returns one
 *     event or request and one result; same key/different evidence returns
 *     409" — W4-postured (shadow) leg: replay returns the stored response with
 *     exactly ONE event + ONE calculation + ONE outbox row; a same-key retry
 *     with a different note payload is 409 with zero new DML. (The
 *     legacy_compat half lives in attendance-w4c2-live-scheduled-boundary.)
 *  5. "forged authorization witness, self user override, wrong scheduler
 *     capability, and inactive membership fail before source/result SQL" —
 *     forged witnesses (spread/JSON clones) fail the registry preflight with
 *     ZERO SQL issued (throwing+counting client: any SQL would surface as the
 *     stub's own distinct error, so the closed code proves the guard fired);
 *     self override and token-subject mismatch are refused at MINT (no SQL
 *     surface exists yet); a scheduler witness with the wrong capability fails
 *     before SQL while the correct capability reaches SQL (positive control
 *     that the counting harness counts); an INACTIVE MEMBERSHIP stable-ID
 *     punch is a values-free 403 with zero source DML, and re-activating the
 *     membership makes the identical punch write (positive control).
 *  6. "fresh authoritative calculator review creates only a retired
 *     review_placeholder ..." — NOT reachable in W4C-2: authoritative write
 *     execution is not delivered by this slice (the boundary fails closed with
 *     `W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED` BEFORE source DML, and no read
 *     route filters `visibility_state` yet). This file pins that fail-closed
 *     substitute on BOTH entrypoints with zero-DML assertions; the
 *     review_placeholder read-side gate transfers to the slice that delivers
 *     authoritative execution (recorded in HANDOFF-W4C2.md + PR body).
 *  7. "`accepted_write_posture` is immutable and cannot be silently rebased" —
 *     storage: direct UPDATE is trigger-denied (W4C0_OPERATION_STATE);
 *     behavior: after a legal legacy->shadow rollout promotion, replaying an
 *     operation sealed under `legacy_projection_only` returns its stored
 *     response with the posture UNCHANGED and zero new DML, while a FRESH key
 *     on the same org takes the shadow path (positive control that the org
 *     really is effective shadow — the replay is not vacuously legacy).
 *     "shadow/eligible promotion is blocked by every incomplete operation/
 *     batch or retryable job" is NOT exercisable in W4C-2: no sanctioned
 *     rollout transition writer ships (fixtures walk raw SQL trigger edges);
 *     the drain-before-promote predicate transfers with the promotion writer
 *     (recorded in HANDOFF-W4C2.md + PR body).
 *  8. "live/scheduled outbox rows are inserted before operation seal" — a
 *     SQL-ORDER probe: a BEFORE UPDATE constraint-style trigger scoped to this
 *     file's org raises unless the outbox row already exists at seal time. The
 *     production shadow punch passes under the installed trigger (order
 *     holds); a module-level claim+seal WITHOUT outbox on the same org is
 *     caught by the same trigger (positive control that the probe fires).
 *     Crash-after-commit/restart/concurrent-dispatcher/emit-failure delivery
 *     legs live in attendance-w4c2-outbox-dispatcher.db.test.ts.
 *  9. "durable scheduled-run replay survives process restart and `skipDedup`
 *     cannot bypass it" — the administrator run route ALWAYS bypasses the
 *     in-process dedup key (skipDedup:true), so the second identical run can
 *     only be deduplicated by the durable registry: it replays per-user with
 *     zero new record/operation/calculation rows and the SAME operation row
 *     (deterministic `source_root_id` == UUIDv5 runId, golden-pinned in
 *     w4c2-frozen-attribution.test.ts). Every input consulted is DB-resident,
 *     which is exactly process-restart equivalence: the only non-durable state
 *     (the in-memory key) is proven bypassed.
 * 10. "restoring the P02 post-upsert mutation fails its own positive-control
 *     leg" — a row-level audit trigger counts attendance_records DML for the
 *     merge user: a merge-flipping internal punch after an approved outdoor
 *     boundary touches the record EXACTLY ONCE and lands the merged boundary
 *     (restoring the legacy second pass makes it two writes; neutering the
 *     merge leaves the outdoor boundary in place — both fail this leg alone).
 *
 * Shared-DB discipline: fixture ids are file-namespaced random UUIDs; W4
 * operation/calculation/outbox/rollout rows are append-only by design and are
 * left in place (keyed by throwaway org UUIDs). The deployment-wide
 * 'attendance.settings' row is snapshot/exact-restored (throttle off + a
 * temporary merge-policy flag for leg 10). The order-probe trigger and the
 * audit trigger are scoped by literal fixture UUIDs and dropped in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import {
  snapshotAttendanceSettingsRow,
  restoreAttendanceSettingsRow,
  type AttendanceSettingsRowSnapshot,
} from '../utils/attendance-settings-row'
import {
  createAuthorizedAttendanceWriteContextV1,
  ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
} from '../../src/attendance/w4c0-authorization'
import { normalizeAttendanceSourceOperationEnvelopeV1 } from '../../src/attendance/w4c0-source-commands'
import {
  attendanceResultOperationPreflightV1,
  runAttendanceResultOperationTransactionV1,
  sealAttendanceResultOperationV1,
} from '../../src/attendance/w4c0-operation-registry'
import type { AttendanceW4TransactionClientV1, VerifiedAttendanceOperationIdentityV1 } from '../../src/attendance/w4c0-identity'
import {
  deriveAttendanceScheduledRunIdV1,
  createAttendanceLiveScheduledBoundaryV1,
  AttendanceW4LiveScheduledBoundaryError,
  type AttendanceW4LiveScheduledLegacyAdaptersV1,
  type AttendanceW4BoundaryConnectionV1,
} from '../../src/attendance/w4c2-live-scheduled-boundary'
import { AttendanceW4OperationError } from '../../src/attendance/w4c0-operation-contract'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const requireCjs = createRequire(import.meta.url)
function resetAttendanceSettingsCacheAfterRestore(): void {
  const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
    resetAttendanceSettingsCacheForTests?: () => void
  }
  plugin.resetAttendanceSettingsCacheForTests?.()
}

type HttpResponse = { status: number; body?: any; raw: string }

function requestJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          let body: unknown
          try { body = data ? JSON.parse(data) : undefined } catch { body = undefined }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describeDb('W4C-2 Stage E gate matrix (real DB: isolation, forged authz, freeze refusals, seal order, durable scheduled replay, P02 single write)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool
  let priorAllowlistEnv: string | undefined
  let settingsRowSnapshot: AttendanceSettingsRowSnapshot | undefined

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
  async function mintToken(userId: string, perms = 'attendance:read,attendance:write'): Promise<string> {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent(perms)}`,
    )
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }
  const punch = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/punch`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })
  const autoAbsenceRun = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/auto-absence/run`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })

  // File-namespaced fixtures (shared DB).
  const ambOrg = randomUUID()
  const isoOrg = randomUUID()
  const isoOrg2 = randomUUID()
  const replayOrg = randomUUID()
  const authzOrg = randomUUID()
  const authoritativeOrg = randomUUID()
  const rebaseOrg = randomUUID()
  const orderOrg = randomUUID()
  const schedOrg = randomUUID()
  const mergeOrg = randomUUID()
  // P1-4 remediation legs (direct boundary construction, no HTTP route).
  const adminWitnessOrg = randomUUID()

  const ambUser = randomUUID()
  const ambControlUser = randomUUID()
  const isoUserA = randomUUID()
  const isoUserB = randomUUID()
  const isoUserC = randomUUID()
  const replayUser = randomUUID()
  const inactiveMemberUser = randomUUID()
  const authoritativeUser = randomUUID()
  const rebaseUser = randomUUID()
  const orderUser = randomUUID()
  const schedUser = randomUUID()
  const schedAmbUser = randomUUID()
  // P1-4 remediation: the real administrator identity for leg 9's admin_run
  // calls (must be an active `users` row for the new in-transaction recheck).
  const schedAdminUser = randomUUID()
  const mergeUser = randomUUID()
  // P1-4 remediation legs.
  const adminWitnessTargetUser = randomUUID()
  const adminWitnessRealAdmin = randomUUID()
  const adminWitnessStaleAdmin = randomUUID()

  const ambShiftA = randomUUID()
  const ambShiftB = randomUUID()
  const ambControlShift = randomUUID()
  const schedAmbShiftA = randomUUID()
  const schedAmbShiftB = randomUUID()

  // DDL-inlined literals (our own generated UUIDs; hex-safe by construction).
  const ORDER_PROBE_FN = 'w4c2_e5_outbox_before_seal_probe'
  const ORDER_PROBE_TRG = 'trg_w4c2_e5_outbox_order'
  const AUDIT_TABLE = 'w4c2_e5_record_write_audit'
  const AUDIT_FN = 'w4c2_e5_record_write_audit_fn'
  const AUDIT_TRG = 'trg_w4c2_e5_record_write_audit'

  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-2 e5 fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w4c2-e5.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }

  async function insertRolloutRow(orgId: string, state: 'legacy' | 'shadow'): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, $2, 'w4c2-e5', 'TEST_FIXTURE', 'w4c2-e5-actor', 1, NULL)`,
      [orgId, state],
    )
  }

  async function walkRolloutToAuthoritative(orgId: string): Promise<void> {
    await insertRolloutRow(orgId, 'legacy')
    const edges: Array<[string, string, number]> = [
      ['shadow', 'legacy', 2],
      ['eligible', 'shadow', 3],
      ['authoritative', 'eligible', 4],
    ]
    for (const [state, prior, version] of edges) {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = $3, version = $4 WHERE org_id = $1`,
        [orgId, state, prior, version],
      )
    }
  }

  async function insertShift(shiftId: string, orgId: string, name: string, start: string, end: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time, timezone)
       VALUES ($1, $2, $3, $4, $5, 'Asia/Shanghai')`,
      [shiftId, orgId, name, start, end],
    )
  }

  async function insertAssignment(orgId: string, userId: string, shiftId: string, slotIndex: number): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
       VALUES ($1, $2, $3, $4, $5, '2026-07-01', NULL, true, 'published', 'regular')`,
      [randomUUID(), orgId, userId, shiftId, slotIndex],
    )
  }

  const eventCount = async (userId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_events WHERE user_id = $1', [userId])).rows[0].n)
  const recordCount = async (userId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_records WHERE user_id = $1', [userId])).rows[0].n)
  const recordRow = async (userId: string) =>
    (await pool.query(
      `SELECT id::text AS id, first_in_at, last_out_at, status,
              current_calculation_id::text AS current_calculation_id, projection_owner, visibility_state, visibility_reason
       FROM attendance_records WHERE user_id = $1`,
      [userId],
    )).rows
  const operationRows = async (orgId: string, entrypoint?: string) =>
    (await pool.query(
      `SELECT operation_id::text AS operation_id, entrypoint, state, accepted_write_posture, actor_id, capability,
              identity_source_kind, source_root_id::text AS source_root_id, proof_user_id, proof_work_date::text AS proof_work_date,
              resolved_record_id::text AS resolved_record_id,
              resolved_calculation_id::text AS resolved_calculation_id, response_snapshot
       FROM attendance_result_operations
       WHERE org_id = $1 AND ($2::text IS NULL OR entrypoint = $2)
       ORDER BY created_at`,
      [orgId, entrypoint ?? null],
    )).rows
  const calculationRowsForUser = async (userId: string) =>
    (await pool.query(
      `SELECT c.id::text AS id, c.org_id, c.version, c.calculation_kind, c.mode, c.entrypoint,
              c.operation_id::text AS operation_id, c.outcome, c.outcome_reason_code,
              c.projection_effect, c.expected_segment_count, c.context_snapshot,
              c.attribution_snapshot, c.evidence_snapshot, c.segment_snapshot,
              r.id::text AS record_id
       FROM attendance_record_calculations c
       JOIN attendance_records r ON r.id = c.attendance_record_id
       WHERE r.user_id = $1
       ORDER BY c.version`,
      [userId],
    )).rows
  const segmentCountForCalculation = async (calculationId: string) =>
    Number((await pool.query(
      'SELECT count(*)::int AS n FROM attendance_record_segments WHERE calculation_id = $1::uuid',
      [calculationId],
    )).rows[0].n)
  const outboxRows = async (orgId: string) =>
    (await pool.query(
      `SELECT id::text AS id, entrypoint, operation_id::text AS operation_id, event_kind, delivery_state
       FROM attendance_result_event_outbox WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    )).rows

  /** Live-punch registry envelope with the boundary's exact payload shape. */
  function livePunchEnvelope(orgId: string, userId: string, operationId: string, occurredAt: string) {
    return normalizeAttendanceSourceOperationEnvelopeV1({
      schemaVersion: 1,
      orgId,
      correlationId: `w4c2-e5:${orgId}:${userId}`,
      command: {
        schemaVersion: 1,
        kind: 'live_punch',
        subjectUserId: userId,
        operationId,
        payload: {
          eventType: 'check_in',
          occurredAt,
          timezone: 'Asia/Shanghai',
          source: 'manual',
          location: null,
          meta: null,
          photoFileRef: null,
        },
      },
      batch: null,
    })
  }

  function scheduledEnvelope(orgId: string, userId: string, workDate: string) {
    const runId = deriveAttendanceScheduledRunIdV1({ initiator: 'admin_run', orgId, workDate })
    return normalizeAttendanceSourceOperationEnvelopeV1({
      schemaVersion: 1,
      orgId,
      correlationId: `w4c2-e5:scheduled:${orgId}:${workDate}`,
      command: {
        schemaVersion: 1,
        kind: 'scheduled',
        subjectUserId: userId,
        operationId: null,
        payload: {
          scheduledRunId: runId,
          userId,
          workDate,
          expectedRunVersion: 1,
          scheduledAbsenceSource: 'admin_auto_absence_run',
        },
      },
      batch: null,
    })
  }

  /**
   * Zero-SQL harness: the client THROWS its own distinct error on any query, so
   * a guard that fails to fire cannot pass this leg silently — the observed
   * error would be the stub's, not the closed authorization code (the failure
   * point of the negative stub lies INSIDE the guard under test).
   */
  function throwingCountingClient(): { client: AttendanceW4TransactionClientV1; count: () => number } {
    let n = 0
    const client = {
      async query(): Promise<{ rows: any[] }> {
        n += 1
        throw new Error('W4C2_E5_STUB_CLIENT_MUST_NOT_BE_REACHED')
      },
    } as unknown as AttendanceW4TransactionClientV1
    return { client, count: () => n }
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('W4C-2 e5 gate matrix integration needs a loopback port + DATABASE_URL')

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    // Exact-org allowlist BEFORE activate (w4c0 posture doctrine: persisted W4
    // state row AND exact env entry). mergeOrg is deliberately NOT listed and
    // carries no rollout row: structurally legacy_projection_only.
    priorAllowlistEnv = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = [
      ambOrg, isoOrg, isoOrg2, replayOrg, authzOrg, authoritativeOrg, rebaseOrg, orderOrg, schedOrg,
      adminWitnessOrg,
    ].join(',')

    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })

    // Deployment-wide settings row: throttle off for multi-punch users; exact
    // restore in afterAll (merge flag is toggled ONLY inside leg 10).
    settingsRowSnapshot = await snapshotAttendanceSettingsRow(pool)
    const adminToken = await mintToken(randomUUID(), 'attendance:read,attendance:write,attendance:admin')
    const putRes = await requestJson(`${baseUrl}/api/attendance/settings`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ minPunchIntervalMinutes: 0 }),
    })
    if (putRes.status !== 200) throw new Error(`settings PUT failed: ${putRes.status}`)

    // Rollout rows.
    for (const orgId of [ambOrg, isoOrg, isoOrg2, replayOrg, authzOrg, orderOrg, schedOrg, adminWitnessOrg]) {
      await insertRolloutRow(orgId, 'shadow')
    }
    await insertRolloutRow(rebaseOrg, 'legacy')
    await walkRolloutToAuthoritative(authoritativeOrg)

    // Users + memberships (W4-postured orgs need the witness SQL recheck rows).
    for (const [userId, orgId] of [
      [ambUser, ambOrg],
      [ambControlUser, ambOrg],
      [isoUserA, isoOrg],
      [isoUserB, isoOrg],
      [isoUserC, isoOrg2],
      [replayUser, replayOrg],
      [inactiveMemberUser, authzOrg],
      [authoritativeUser, authoritativeOrg],
      [rebaseUser, rebaseOrg],
      [orderUser, orderOrg],
      [schedUser, schedOrg],
      [schedAmbUser, schedOrg],
      [mergeUser, mergeOrg],
      [adminWitnessTargetUser, adminWitnessOrg],
    ] as const) {
      await insertActiveUser(userId, orgId)
    }
    // Leg 5 fixture: the membership exists but is INACTIVE (deprovision between
    // mint and use); the leg itself re-activates it for the positive control.
    await pool.query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [
      inactiveMemberUser, authzOrg,
    ])
    // Leg 9 (P1-4 remediation): schedAdminUser is a real active `users` row
    // but DELIBERATELY carries NO schedOrg membership — platform_admin posture
    // waives requireActiveMembership (see adminRunScheduledAuthorization), and
    // this also proves the admin actor is not itself picked up as an
    // absence-generation TARGET (insertActiveUser's [userId, orgId] loop above
    // enrolls schedOrg membership, which would inflate leg 9's generated count).
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-2 e5 admin-run fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [schedAdminUser, `${schedAdminUser}@w4c2-e5.test`],
    )
    // P1-4 remediation legs: a second real active admin (users-only, no
    // adminWitnessOrg membership — platform_admin waives it) for the positive
    // control. adminWitnessStaleAdmin is DELIBERATELY never inserted anywhere.
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-2 e5 admin-witness fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [adminWitnessRealAdmin, `${adminWitnessRealAdmin}@w4c2-e5.test`],
    )

    // W2 ambiguity fixtures: two overlapping published day shifts on the same
    // work date (both absolute windows contain the punch instant) — the natural
    // OVERLAPPING_SHIFT_WINDOWS shape, not a synthetic resolver stub.
    await insertShift(ambShiftA, ambOrg, 'w4c2-e5-amb-a', '09:00', '18:00')
    await insertShift(ambShiftB, ambOrg, 'w4c2-e5-amb-b', '08:00', '17:00')
    await insertAssignment(ambOrg, ambUser, ambShiftA, 0)
    await insertAssignment(ambOrg, ambUser, ambShiftB, 1)
    await insertShift(ambControlShift, ambOrg, 'w4c2-e5-amb-ctrl', '09:00', '18:00')
    await insertAssignment(ambOrg, ambControlUser, ambControlShift, 0)
    // Scheduled ambiguity fixtures (schedOrg).
    await insertShift(schedAmbShiftA, schedOrg, 'w4c2-e5-samb-a', '09:00', '18:00')
    await insertShift(schedAmbShiftB, schedOrg, 'w4c2-e5-samb-b', '08:00', '17:00')
    await insertAssignment(schedOrg, schedAmbUser, schedAmbShiftA, 0)
    await insertAssignment(schedOrg, schedAmbUser, schedAmbShiftB, 1)

    // Leg 8 order probe: BEFORE UPDATE trigger scoped to orderOrg — the seal
    // (state -> completed) must observe its own outbox row already inserted.
    await pool.query(`
      CREATE OR REPLACE FUNCTION ${ORDER_PROBE_FN}() RETURNS trigger AS $probe$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM attendance_result_event_outbox o
          WHERE o.org_id = NEW.org_id AND o.entrypoint = NEW.entrypoint AND o.operation_id = NEW.operation_id
        ) THEN
          RAISE EXCEPTION 'W4C2_E5_SEAL_BEFORE_OUTBOX';
        END IF;
        RETURN NEW;
      END
      $probe$ LANGUAGE plpgsql`)
    await pool.query(`
      CREATE TRIGGER ${ORDER_PROBE_TRG}
        BEFORE UPDATE ON attendance_result_operations
        FOR EACH ROW
        WHEN (NEW.org_id = '${orderOrg}' AND NEW.state = 'completed')
        EXECUTE FUNCTION ${ORDER_PROBE_FN}()`)

    // Leg 10 audit: row-level DML counter scoped to mergeUser.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (user_id text NOT NULL, op text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp())`)
    await pool.query(`
      CREATE OR REPLACE FUNCTION ${AUDIT_FN}() RETURNS trigger AS $audit$
      BEGIN
        INSERT INTO ${AUDIT_TABLE} (user_id, op) VALUES (NEW.user_id, TG_OP);
        RETURN NEW;
      END
      $audit$ LANGUAGE plpgsql`)
    await pool.query(`
      CREATE TRIGGER ${AUDIT_TRG}
        AFTER INSERT OR UPDATE ON attendance_records
        FOR EACH ROW
        WHEN (NEW.user_id = '${mergeUser}')
        EXECUTE FUNCTION ${AUDIT_FN}()`)
  }, 120000)

  afterAll(async () => {
    // Teardown-scoped absorber (#4608 form): attach the no-op handler ONLY at
    // teardown start so an async FATAL during the tests still fails loudly.
    pool?.on('error', () => undefined)
    await pool?.query(`DROP TRIGGER IF EXISTS ${ORDER_PROBE_TRG} ON attendance_result_operations`).catch(() => undefined)
    await pool?.query(`DROP FUNCTION IF EXISTS ${ORDER_PROBE_FN}()`).catch(() => undefined)
    await pool?.query(`DROP TRIGGER IF EXISTS ${AUDIT_TRG} ON attendance_records`).catch(() => undefined)
    await pool?.query(`DROP FUNCTION IF EXISTS ${AUDIT_FN}()`).catch(() => undefined)
    await pool?.query(`DROP TABLE IF EXISTS ${AUDIT_TABLE}`).catch(() => undefined)
    if (settingsRowSnapshot) {
      await restoreAttendanceSettingsRow(pool, settingsRowSnapshot).catch(() => undefined)
      resetAttendanceSettingsCacheAfterRestore()
    }
    for (const userId of [
      ambUser, ambControlUser, isoUserA, isoUserB, isoUserC, replayUser, inactiveMemberUser,
      authoritativeUser, rebaseUser, orderUser, schedUser, schedAmbUser, schedAdminUser, mergeUser,
      adminWitnessTargetUser, adminWitnessRealAdmin,
    ]) {
      await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined)
    }
    if (priorAllowlistEnv === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlistEnv
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
  }, 60000)

  it('leg 1 — W2 ambiguity: positive control resolves completed; two overlapping assignments are refused by the preserved legacy 422 with ZERO parent/result rows', async () => {
    // POSITIVE CONTROL first: single assignment on the same org => resolved_v2
    // completed. The ambiguous refusal below cannot pass vacuously.
    const controlToken = await mintToken(ambControlUser)
    const controlOp = randomUUID()
    const control = await punch(controlToken, {
      eventType: 'check_in', occurredAt: '2026-07-20T01:05:00.000Z', orgId: ambOrg, operationId: controlOp,
    })
    expect(control.status).toBe(200)
    const controlCalcs = await calculationRowsForUser(ambControlUser)
    expect(controlCalcs.length).toBe(1)
    expect(controlCalcs[0]).toMatchObject({
      mode: 'shadow',
      entrypoint: 'live',
      outcome: 'completed',
      outcome_reason_code: 'calculated',
      projection_effect: 'none',
    })
    expect(controlCalcs[0].attribution_snapshot.posture).toBe('resolved_v2')
    // The completed shadow result never moves the parent pointer either.
    const controlParents = await recordRow(ambControlUser)
    expect(controlParents.length).toBe(1)
    expect(controlParents[0]).toMatchObject({
      current_calculation_id: null,
      projection_owner: 'legacy_untracked',
      visibility_state: 'active',
      visibility_reason: 'active',
    })

    // Ambiguity: punch inside BOTH absolute windows (10:00 local Asia/Shanghai).
    // The preserved legacy route contract (R5/OD-4556-8) refuses the silent
    // work-date pick BEFORE the boundary — under effective shadow exactly as
    // under legacy — so fresh live W2 ambiguity creates NO parent and NO
    // result: zero events, zero records, zero operations, zero calculations,
    // zero outbox rows.
    const token = await mintToken(ambUser)
    const operationId = randomUUID()
    const before = (await operationRows(ambOrg)).length
    const outboxBefore = (await outboxRows(ambOrg)).length
    const res = await punch(token, {
      eventType: 'check_in', occurredAt: '2026-07-20T02:00:00.000Z', orgId: ambOrg, operationId,
    })
    expect(res.status).toBe(422)
    expect(res.body?.error?.code).toBe('WORK_DATE_ATTRIBUTION_AMBIGUOUS')
    expect(await eventCount(ambUser)).toBe(0)
    expect(await recordCount(ambUser)).toBe(0)
    expect((await calculationRowsForUser(ambUser)).length).toBe(0)
    expect((await operationRows(ambOrg)).length).toBe(before)
    expect((await outboxRows(ambOrg)).length).toBe(outboxBefore)
  })

  it('leg 2 — storage backstop: a completed calculation whose attribution is not resolved_v2 is CHECK-rejected (never castable to V2 at rest)', async () => {
    const parents = await recordRow(ambControlUser)
    expect(parents.length).toBe(1)
    const recordId = parents[0].id
    const next = Number(
      (await pool.query(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM attendance_record_calculations WHERE attendance_record_id = $1::uuid',
        [recordId],
      )).rows[0].next,
    )
    const hex64 = 'ab'.repeat(32)
    await expect(
      pool.query(
        `INSERT INTO attendance_record_calculations (
            id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
            engine_version, snapshot_schema_version, operation_id,
            semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
            attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
            approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
            outcome, outcome_reason_code, projection_effect, expected_segment_count,
            projected_status, projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
            actor_id, correlation_id
          ) VALUES (
            $1::uuid, $2, $3::uuid, $4, 'calculation', 'shadow', 'live',
            'w4c2-e5-negative', 1, $5::uuid,
            $6, $6, $6,
            '{"posture":"unsupported","sourceSchemaVersion":null,"reason":"ambiguous","sourceFingerprint":null}'::jsonb,
            '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
            '[]'::jsonb, '{}'::jsonb, 'append', 'legacy_shadow',
            'completed', 'calculated', 'none', 1,
            'normal', 0, 0, 0,
            'w4c2-e5', 'w4c2-e5'
          )`,
        [randomUUID(), ambOrg, recordId, next, randomUUID(), hex64],
      ),
    ).rejects.toThrow(/chk_arc_completed_shape/)
  })

  it('leg 3 — same-org other-user: the same operation key from a different actor is a closed 409 with zero DML; cross-org the key is an independent operation', async () => {
    const sharedKey = randomUUID()
    const body = { eventType: 'check_in' as const, occurredAt: '2026-07-20T01:00:00.000Z', operationId: sharedKey }

    const tokenA = await mintToken(isoUserA)
    const first = await punch(tokenA, { ...body, orgId: isoOrg })
    expect(first.status).toBe(200)
    expect(await eventCount(isoUserA)).toBe(1)
    expect((await operationRows(isoOrg, 'live_punch')).length).toBe(1)

    // Same org, same key, DIFFERENT actor: closed conflict, zero DML for B.
    const tokenB = await mintToken(isoUserB)
    const conflict = await punch(tokenB, { ...body, orgId: isoOrg })
    expect(conflict.status).toBe(409)
    expect(conflict.body?.error?.code).toBe('ATTENDANCE_OPERATION_CONFLICT')
    expect(conflict.body?.error?.message).toBe('ATTENDANCE_OPERATION_CONFLICT')
    expect(await eventCount(isoUserB)).toBe(0)
    expect(await recordCount(isoUserB)).toBe(0)
    const opsAfterConflict = await operationRows(isoOrg, 'live_punch')
    expect(opsAfterConflict.length).toBe(1)
    expect(opsAfterConflict[0].actor_id).toBe(isoUserA)

    // Cross-org: the same key is an INDEPENDENT operation (PK includes org).
    const tokenC = await mintToken(isoUserC)
    const other = await punch(tokenC, { ...body, orgId: isoOrg2 })
    expect(other.status).toBe(200)
    expect(await eventCount(isoUserC)).toBe(1)
    const org2Ops = await operationRows(isoOrg2, 'live_punch')
    expect(org2Ops.length).toBe(1)
    expect(org2Ops[0]).toMatchObject({ operation_id: sharedKey, actor_id: isoUserC, state: 'completed' })
    // Neither org observed the other: org1 rows are untouched by org2's write.
    const org1Ops = await operationRows(isoOrg, 'live_punch')
    expect(org1Ops.length).toBe(1)
    expect(org1Ops[0].actor_id).toBe(isoUserA)
    expect(org1Ops[0].response_snapshot).toEqual(first.body.data)
  })

  it('leg 4 — W4 shadow response-loss retry: replay returns the stored response with ONE event and ONE result; a different outdoor-note payload on the same key is 409', async () => {
    const token = await mintToken(replayUser)
    const operationId = randomUUID()
    const body = {
      eventType: 'check_in' as const,
      occurredAt: '2026-07-20T01:00:00.000Z',
      orgId: replayOrg,
      operationId,
      meta: { note: 'outdoor-note-original' },
    }
    const first = await punch(token, body)
    expect(first.status).toBe(200)
    expect(await eventCount(replayUser)).toBe(1)
    expect((await calculationRowsForUser(replayUser)).length).toBe(1)
    expect((await outboxRows(replayOrg)).length).toBe(1)

    // Response-loss retry: byte-equal stored response, still ONE of everything.
    const replay = await punch(token, body)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(await eventCount(replayUser)).toBe(1)
    expect((await calculationRowsForUser(replayUser)).length).toBe(1)
    expect((await outboxRows(replayOrg)).length).toBe(1)
    expect((await operationRows(replayOrg, 'live_punch')).length).toBe(1)

    // Same key, different note evidence: closed 409, zero new DML.
    const conflict = await punch(token, { ...body, meta: { note: 'outdoor-note-DIFFERENT' } })
    expect(conflict.status).toBe(409)
    expect(conflict.body?.error?.code).toBe('ATTENDANCE_OPERATION_CONFLICT')
    expect(await eventCount(replayUser)).toBe(1)
    expect((await calculationRowsForUser(replayUser)).length).toBe(1)
    expect((await outboxRows(replayOrg)).length).toBe(1)
  })

  it('leg 5a — forged authorization witness: spread/JSON clones fail the registry preflight with ZERO SQL issued; a real witness reaches SQL (positive control)', async () => {
    const envelope = livePunchEnvelope(isoOrg, isoUserA, randomUUID(), '2026-07-21T01:00:00.000Z')
    const witness = createAuthorizedAttendanceWriteContextV1({
      actorId: isoUserA,
      actorPosture: 'self',
      tokenSubjectUserId: isoUserA,
      orgId: isoOrg,
      subjectScope: { kind: 'self', userId: isoUserA },
      capability: 'punch',
      sourceRef: 'w4c2-e5:forged-witness-leg',
    })

    for (const forged of [{ ...(witness as unknown as Record<string, unknown>) }, JSON.parse(JSON.stringify(witness))]) {
      const { client, count } = throwingCountingClient()
      await expect(
        attendanceResultOperationPreflightV1(client, forged, envelope.registryInput),
      ).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
      expect(count()).toBe(0)
    }

    // POSITIVE CONTROL: the SAME envelope with the REAL witness reaches SQL
    // (recheck + reads + claim) — proving the zero-SQL assertion above is a
    // discriminating harness, then rolling everything back via a sentinel.
    const raw = await pool.connect()
    let issued = 0
    const countingReal = {
      query: async (text: string, params?: unknown[]) => {
        issued += 1
        return raw.query(text, params as any[])
      },
    } as unknown as AttendanceW4TransactionClientV1
    try {
      await expect(
        runAttendanceResultOperationTransactionV1(countingReal, async (trx) => {
          const preflight = await attendanceResultOperationPreflightV1(trx, witness, envelope.registryInput)
          expect(preflight.kind).toBe('claimed')
          throw new Error('W4C2_E5_ROLLBACK_SENTINEL')
        }),
      ).rejects.toThrow('W4C2_E5_ROLLBACK_SENTINEL')
    } finally {
      raw.release()
    }
    expect(issued).toBeGreaterThan(0)
  })

  it('leg 5b — self user override and token-subject mismatch are refused at MINT (closed codes; no SQL surface exists yet)', () => {
    expect(() =>
      createAuthorizedAttendanceWriteContextV1({
        actorId: isoUserA,
        actorPosture: 'self',
        tokenSubjectUserId: isoUserA,
        orgId: isoOrg,
        subjectScope: { kind: 'self', userId: isoUserB },
        capability: 'punch',
        sourceRef: 'w4c2-e5:self-override-leg',
      }),
    ).toThrow('W4C0_SELF_SCOPE_USER_MISMATCH')
    expect(() =>
      createAuthorizedAttendanceWriteContextV1({
        actorId: isoUserA,
        actorPosture: 'self',
        tokenSubjectUserId: isoUserB,
        orgId: isoOrg,
        subjectScope: { kind: 'self', userId: isoUserA },
        capability: 'punch',
        sourceRef: 'w4c2-e5:token-subject-leg',
      }),
    ).toThrow('W4C0_TOKEN_SUBJECT_MISMATCH')
    // Scheduler scope is bound to the scheduler posture (structural half of the
    // registered-internal-scheduler rule).
    expect(() =>
      createAuthorizedAttendanceWriteContextV1({
        actorId: isoUserA,
        actorPosture: 'self',
        tokenSubjectUserId: isoUserA,
        orgId: isoOrg,
        subjectScope: { kind: 'org_scheduler' },
        capability: 'scheduled',
        sourceRef: 'w4c2-e5:scheduler-scope-leg',
      }),
    ).toThrow('W4C0_SCHEDULER_SCOPE_POSTURE_MISMATCH')
  })

  it('leg 5c — wrong scheduler capability fails before ANY SQL; the correct capability reaches SQL (positive control)', async () => {
    const envelope = scheduledEnvelope(schedOrg, schedUser, '2026-07-21')
    const wrongCapability = createAuthorizedAttendanceWriteContextV1({
      actorId: ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
      actorPosture: 'scheduler',
      tokenSubjectUserId: null,
      orgId: schedOrg,
      subjectScope: { kind: 'org_scheduler' },
      capability: 'punch', // scheduled entrypoint requires 'scheduled'
      sourceRef: 'w4c2-e5:wrong-capability-leg',
    })
    const { client, count } = throwingCountingClient()
    await expect(
      attendanceResultOperationPreflightV1(client, wrongCapability, envelope.registryInput),
    ).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(count()).toBe(0)

    // POSITIVE CONTROL: same envelope, correct capability => reaches SQL, then
    // rolls back via sentinel (zero durable rows).
    const correct = createAuthorizedAttendanceWriteContextV1({
      actorId: ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
      actorPosture: 'scheduler',
      tokenSubjectUserId: null,
      orgId: schedOrg,
      subjectScope: { kind: 'org_scheduler' },
      capability: 'scheduled',
      sourceRef: 'w4c2-e5:correct-capability-control',
    })
    const raw = await pool.connect()
    let issued = 0
    const countingReal = {
      query: async (text: string, params?: unknown[]) => {
        issued += 1
        return raw.query(text, params as any[])
      },
    } as unknown as AttendanceW4TransactionClientV1
    try {
      await expect(
        runAttendanceResultOperationTransactionV1(countingReal, async (trx) => {
          const preflight = await attendanceResultOperationPreflightV1(trx, correct, envelope.registryInput)
          expect(preflight.kind).toBe('claimed')
          throw new Error('W4C2_E5_ROLLBACK_SENTINEL')
        }),
      ).rejects.toThrow('W4C2_E5_ROLLBACK_SENTINEL')
    } finally {
      raw.release()
    }
    expect(issued).toBeGreaterThan(0)
    expect((await operationRows(schedOrg, 'scheduled')).length).toBe(0)
  })

  it('leg 5e — P2-1 remediation (#4612 gate finding): a scheduler-postured witness with a NON-REGISTERED actorId fails the ordinary active-user recheck (the adjacent comment claims this as an invariant; K11 previously widened the exemption to any actorId and 789/789 stayed green — this leg makes the claim a tested one)', async () => {
    const envelope = scheduledEnvelope(schedOrg, schedUser, '2026-07-23')
    // Any scheduler-postured actorId OTHER than the registered constant must
    // still fail the ordinary active-user recheck — even one shaped like a
    // real UUID, deliberately never inserted into `users`.
    const forgedActorId = randomUUID()
    const forgedSchedulerWitness = createAuthorizedAttendanceWriteContextV1({
      actorId: forgedActorId,
      actorPosture: 'scheduler',
      tokenSubjectUserId: null,
      orgId: schedOrg,
      subjectScope: { kind: 'org_scheduler' },
      capability: 'scheduled',
      sourceRef: 'w4c2-e5:scheduler-non-registered-actor-leg',
    })
    const opsBefore = (await operationRows(schedOrg, 'scheduled')).length
    const raw = await pool.connect()
    try {
      await expect(
        runAttendanceResultOperationTransactionV1(raw as unknown as AttendanceW4TransactionClientV1, (trx) =>
          attendanceResultOperationPreflightV1(trx, forgedSchedulerWitness, envelope.registryInput),
        ),
      ).rejects.toThrow('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    } finally {
      raw.release()
    }
    // Zero durable rows from this call (delta, not absolute — leg 5c/leg 9
    // write their own rows to this same org earlier/later in the file).
    expect((await operationRows(schedOrg, 'scheduled')).length).toBe(opsBefore)

    // POSITIVE CONTROL: identical shape, actorId IS the registered constant —
    // reaches SQL and is authorized (leg 5c already proves this exact witness
    // shape claims successfully; re-asserted here as the paired control for
    // THIS leg's specific mutation axis — actorId, not capability).
    const registered = createAuthorizedAttendanceWriteContextV1({
      actorId: ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
      actorPosture: 'scheduler',
      tokenSubjectUserId: null,
      orgId: schedOrg,
      subjectScope: { kind: 'org_scheduler' },
      capability: 'scheduled',
      sourceRef: 'w4c2-e5:scheduler-non-registered-actor-control',
    })
    const rawControl = await pool.connect()
    try {
      await expect(
        runAttendanceResultOperationTransactionV1(rawControl as unknown as AttendanceW4TransactionClientV1, async (trx) => {
          const preflight = await attendanceResultOperationPreflightV1(trx, registered, envelope.registryInput)
          expect(preflight.kind).toBe('claimed')
          throw new Error('W4C2_E5_LEG5E_ROLLBACK_SENTINEL')
        }),
      ).rejects.toThrow('W4C2_E5_LEG5E_ROLLBACK_SENTINEL')
    } finally {
      rawControl.release()
    }
  })

  it('leg 5d — inactive membership: the stable-ID punch is a values-free 403 with ZERO source DML; re-activating the membership makes the identical punch write (positive control)', async () => {
    const token = await mintToken(inactiveMemberUser)
    const body = {
      eventType: 'check_in' as const,
      occurredAt: '2026-07-20T01:00:00.000Z',
      orgId: authzOrg,
      operationId: randomUUID(),
    }
    const refused = await punch(token, body)
    expect(refused.status).toBe(403)
    expect(refused.body?.error?.code).toBe('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(refused.body?.error?.message).toBe('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    expect(await eventCount(inactiveMemberUser)).toBe(0)
    expect(await recordCount(inactiveMemberUser)).toBe(0)
    // The claim rolled back with the transaction: zero operation rows.
    expect((await operationRows(authzOrg)).length).toBe(0)
    expect((await outboxRows(authzOrg)).length).toBe(0)

    // POSITIVE CONTROL: active membership => the identical punch writes.
    await pool.query('UPDATE user_orgs SET is_active = true WHERE user_id = $1 AND org_id = $2', [
      inactiveMemberUser, authzOrg,
    ])
    const accepted = await punch(token, { ...body, operationId: randomUUID() })
    expect(accepted.status).toBe(200)
    expect(await eventCount(inactiveMemberUser)).toBe(1)
    expect((await operationRows(authzOrg)).length).toBe(1)
  })

  it('leg 6 — authoritative posture fails closed BEFORE source DML on both entrypoints (review_placeholder read-side gate transfers with authoritative delivery)', async () => {
    // Live: the claim is discarded by the rollback; nothing persists.
    const token = await mintToken(authoritativeUser)
    const res = await punch(token, {
      eventType: 'check_in',
      occurredAt: '2026-07-20T01:00:00.000Z',
      orgId: authoritativeOrg,
      operationId: randomUUID(),
    })
    expect(res.status).toBe(503)
    expect(res.body?.error?.code).toBe('W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED')
    expect(res.body?.error?.message).toBe('W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED')
    expect(await eventCount(authoritativeUser)).toBe(0)
    expect(await recordCount(authoritativeUser)).toBe(0)
    expect((await operationRows(authoritativeOrg)).length).toBe(0)
    expect((await outboxRows(authoritativeOrg)).length).toBe(0)
    expect((await calculationRowsForUser(authoritativeUser)).length).toBe(0)

    // Scheduled: the administrator run fails closed the same way, zero rows.
    const adminToken = await mintToken(randomUUID(), 'attendance:read,attendance:write,attendance:admin')
    const run = await autoAbsenceRun(adminToken, { orgId: authoritativeOrg, workDate: '2026-07-22' })
    expect(run.status).toBe(503)
    expect(run.body?.error?.code).toBe('W4C2_AUTHORITATIVE_MODE_NOT_DELIVERED')
    expect(await recordCount(authoritativeUser)).toBe(0)
    expect((await operationRows(authoritativeOrg)).length).toBe(0)
  })

  it('leg 7 — accepted_write_posture cannot be silently rebased: replay after legacy->shadow promotion returns the stored legacy response unchanged; a fresh key takes the shadow path; direct UPDATE is trigger-denied', async () => {
    const token = await mintToken(rebaseUser)
    const operationId = randomUUID()
    const body = { eventType: 'check_in' as const, occurredAt: '2026-07-20T01:00:00.000Z', orgId: rebaseOrg, operationId }

    // Sealed under legacy_projection_only (stable-ID compatibility operation).
    const first = await punch(token, body)
    expect(first.status).toBe(200)
    const opsBefore = await operationRows(rebaseOrg, 'live_punch')
    expect(opsBefore.length).toBe(1)
    expect(opsBefore[0]).toMatchObject({ accepted_write_posture: 'legacy_projection_only', state: 'completed' })
    expect((await calculationRowsForUser(rebaseUser)).length).toBe(0)

    // Legal promotion AFTER the seal: legacy -> shadow (org is allowlisted, so
    // the persisted shadow row is now EFFECTIVE).
    await pool.query(
      `UPDATE attendance_calculation_rollout_state SET state = 'shadow', prior_state = 'legacy', version = 2 WHERE org_id = $1`,
      [rebaseOrg],
    )

    // Replay of the legacy-sealed key: stored response, posture UNCHANGED,
    // zero new DML — never silently rebased onto the new posture.
    const replay = await punch(token, body)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(await eventCount(rebaseUser)).toBe(1)
    const opsAfterReplay = await operationRows(rebaseOrg, 'live_punch')
    expect(opsAfterReplay.length).toBe(1)
    expect(opsAfterReplay[0].accepted_write_posture).toBe('legacy_projection_only')
    expect((await calculationRowsForUser(rebaseUser)).length).toBe(0)
    expect((await outboxRows(rebaseOrg)).length).toBe(0)

    // POSITIVE CONTROL: a FRESH key on the same org takes the shadow path now
    // (the org really is effective shadow — the replay above is not vacuous).
    const freshKey = randomUUID()
    const fresh = await punch(token, { ...body, occurredAt: '2026-07-20T02:00:00.000Z', operationId: freshKey })
    expect(fresh.status).toBe(200)
    const opsAfterFresh = await operationRows(rebaseOrg, 'live_punch')
    expect(opsAfterFresh.length).toBe(2)
    const freshOp = opsAfterFresh.find((row) => row.operation_id === freshKey)
    expect(freshOp).toMatchObject({ accepted_write_posture: 'shadow', state: 'completed' })
    expect((await calculationRowsForUser(rebaseUser)).length).toBe(1)

    // Storage half: the frozen posture cannot be rewritten at all.
    await expect(
      pool.query(
        `UPDATE attendance_result_operations SET accepted_write_posture = 'shadow'
         WHERE org_id = $1 AND entrypoint = 'live_punch' AND operation_id = $2::uuid`,
        [rebaseOrg, operationId],
      ),
    ).rejects.toThrow(/W4C0_OPERATION_STATE/)
  })

  it('leg 8 — outbox rows are inserted BEFORE the operation seal: the production shadow punch passes the SQL-order probe; a seal WITHOUT outbox on the same org is caught by it', async () => {
    // POSITIVE CONTROL first: a module-level claim + seal that never enqueues
    // an outbox row trips the probe trigger — the probe demonstrably fires.
    const controlEnvelope = livePunchEnvelope(orderOrg, orderUser, randomUUID(), '2026-07-20T01:00:00.000Z')
    const controlWitness = createAuthorizedAttendanceWriteContextV1({
      actorId: orderUser,
      actorPosture: 'self',
      tokenSubjectUserId: orderUser,
      orgId: orderOrg,
      subjectScope: { kind: 'self', userId: orderUser },
      capability: 'punch',
      sourceRef: 'w4c2-e5:seal-order-control',
    })
    const raw = await pool.connect()
    try {
      await expect(
        runAttendanceResultOperationTransactionV1(raw as unknown as AttendanceW4TransactionClientV1, async (trx) => {
          const preflight = await attendanceResultOperationPreflightV1(trx, controlWitness, controlEnvelope.registryInput)
          expect(preflight.kind).toBe('claimed')
          if (preflight.kind !== 'claimed') throw new Error('unreachable')
          const identity = preflight.itemIdentities[0] as VerifiedAttendanceOperationIdentityV1
          await sealAttendanceResultOperationV1(trx, identity, { responseSnapshot: { probe: true } })
          return null
        }),
      ).rejects.toThrow(/W4C2_E5_SEAL_BEFORE_OUTBOX/)
    } finally {
      raw.release()
    }
    expect((await operationRows(orderOrg)).length).toBe(0)

    // Production path UNDER THE SAME INSTALLED TRIGGER: the shadow punch seals
    // successfully, which is only possible if its outbox row was inserted
    // before the seal statement ran.
    const token = await mintToken(orderUser)
    const operationId = randomUUID()
    const res = await punch(token, {
      eventType: 'check_in', occurredAt: '2026-07-20T01:00:00.000Z', orgId: orderOrg, operationId,
    })
    expect(res.status).toBe(200)
    const ops = await operationRows(orderOrg, 'live_punch')
    expect(ops.length).toBe(1)
    expect(ops[0]).toMatchObject({ operation_id: operationId, state: 'completed', accepted_write_posture: 'shadow' })
    const outbox = await outboxRows(orderOrg)
    expect(outbox.length).toBe(1)
    expect(outbox[0]).toMatchObject({ operation_id: operationId, event_kind: 'attendance.punched', delivery_state: 'pending' })
  })

  it('leg 9 — durable scheduled-run replay: the second administrator run replays per-user with zero DML on the SAME deterministic operation; W2-ambiguous user gets no parent/result; skipDedup cannot bypass the registry', async () => {
    // W4C-2 remediation P1-4 (#4612 gate finding): admin_run now mints its
    // witness from the ROUTE's real authenticated actor id (platform_admin
    // posture, requireActiveUser only — see adminRunScheduledAuthorization's
    // module comment), so the admin token's subject must be a real active
    // `users` row (inserted in beforeAll) or the in-transaction recheck 403s
    // before any source DML.
    const adminToken = await mintToken(schedAdminUser, 'attendance:read,attendance:write,attendance:admin')
    const workDate = '2026-07-22'
    const expectedRunId = deriveAttendanceScheduledRunIdV1({ initiator: 'admin_run', orgId: schedOrg, workDate })

    // Run 1: schedUser (rule-derived, no shift) generates ONE absent record and
    // ONE sealed scheduled operation; schedAmbUser resolves AMBIGUOUS and is
    // review-listed with NO record/operation/calculation (fresh W2 ambiguity
    // creates no parent/result on the scheduled side).
    const first = await autoAbsenceRun(adminToken, { orgId: schedOrg, workDate })
    expect(first.status).toBe(200)
    expect(first.body?.data).toMatchObject({ skipped: false, generated: 1, total: 1 })
    expect(first.body.data.reviewRequired).toEqual([
      { userId: schedAmbUser, reasonCode: 'WORK_DATE_ATTRIBUTION_AMBIGUOUS' },
    ])
    expect(await recordCount(schedUser)).toBe(1)
    expect(await recordCount(schedAmbUser)).toBe(0)
    expect((await calculationRowsForUser(schedAmbUser)).length).toBe(0)

    const opsAfterFirst = await operationRows(schedOrg, 'scheduled')
    expect(opsAfterFirst.length).toBe(1)
    expect(opsAfterFirst[0]).toMatchObject({
      state: 'completed',
      accepted_write_posture: 'shadow',
      identity_source_kind: 'scheduled',
      source_root_id: expectedRunId,
      proof_user_id: schedUser,
      proof_work_date: workDate,
      // P1-4: the real administrator identity, NOT the internal scheduler
      // constant — this operation row (and its audit chain) now records who
      // actually triggered the run.
      actor_id: schedAdminUser,
      capability: 'scheduled',
    })
    const firstOperationId = opsAfterFirst[0].operation_id

    // Shadow result appended for the generated absence (no shift assignment =>
    // closed missing-context review; never a guessed completed calculation).
    const schedCalcs = await calculationRowsForUser(schedUser)
    expect(schedCalcs.length).toBe(1)
    expect(schedCalcs[0]).toMatchObject({
      mode: 'shadow',
      entrypoint: 'scheduled',
      operation_id: firstOperationId,
      outcome: 'review_required',
      outcome_reason_code: 'missing_frozen_context',
      projection_effect: 'none',
      expected_segment_count: 0,
    })
    // "existing parent may append ONLY an unsupported review with zero
    // children/no pointer": zero segment children, and the parent record keeps
    // NO W4 pointer (legacy-owned, active projection).
    expect(await segmentCountForCalculation(schedCalcs[0].id)).toBe(0)
    const schedParents = await recordRow(schedUser)
    expect(schedParents.length).toBe(1)
    expect(schedParents[0]).toMatchObject({
      current_calculation_id: null,
      projection_owner: 'legacy_untracked',
      visibility_state: 'active',
      visibility_reason: 'active',
    })

    // Run 2 — the route ALWAYS bypasses the in-process dedup key
    // (skipDedup:true), so only the durable registry can deduplicate this run.
    // Every consulted input (operation row, deterministic runId, records) is
    // DB-resident: this second run is exactly what a freshly restarted process
    // would execute, and it must replay with ZERO new DML.
    const second = await autoAbsenceRun(adminToken, { orgId: schedOrg, workDate })
    expect(second.status).toBe(200)
    expect(second.body?.data).toMatchObject({ skipped: false, generated: 0, total: 0 })
    expect(await recordCount(schedUser)).toBe(1)
    const opsAfterSecond = await operationRows(schedOrg, 'scheduled')
    expect(opsAfterSecond.length).toBe(1)
    expect(opsAfterSecond[0].operation_id).toBe(firstOperationId)
    expect((await calculationRowsForUser(schedUser)).length).toBe(1)
    expect(await recordCount(schedAmbUser)).toBe(0)
  })

  it('leg 10 — P02 single-write discriminator: a merge-flipping internal punch touches attendance_records EXACTLY ONCE and lands the merged boundary', async () => {
    // Enable the merge policy (deployment-wide setting; restored below and the
    // whole row is exact-restored in afterAll).
    const adminToken = await mintToken(randomUUID(), 'attendance:read,attendance:write,attendance:admin')
    const enable = await requestJson(`${baseUrl}/api/attendance/settings`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ punchPolicy: { merge: { internalWinsOnIn: true } } }),
    })
    expect(enable.status).toBe(200)
    try {
      // Fixture mimicking the S3 approved-outdoor writer (the route itself
      // refuses the reserved source): an approved outdoor check_in at 00:30Z
      // owns the record's first-in boundary.
      const workDate = '2026-07-20'
      await pool.query(
        `INSERT INTO attendance_events (id, user_id, org_id, work_date, occurred_at, event_type, source, timezone, location, meta)
         VALUES ($1, $2, $3, $4, '2026-07-20T00:30:00.000Z', 'check_in', 'outdoor_approval', 'Asia/Shanghai', '{}'::jsonb, '{}'::jsonb)`,
        [randomUUID(), mergeUser, mergeOrg, workDate],
      )
      await pool.query(
        `INSERT INTO attendance_records
           (user_id, org_id, work_date, timezone, first_in_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, created_at, updated_at)
         VALUES ($1, $2, $3, 'Asia/Shanghai', '2026-07-20T00:30:00.000Z', 0, 0, 0, 'normal', true, now(), now())`,
        [mergeUser, mergeOrg, workDate],
      )

      // Count ONLY the punch below.
      await pool.query(`DELETE FROM ${AUDIT_TABLE} WHERE user_id = $1`, [mergeUser])

      // Internal check_in at 01:00Z: append alone would keep 00:30 (min), but
      // internalWinsOnIn protects the earliest INTERNAL check_in => the merge
      // decision flips the boundary to 01:00 — the P02-lifted path applies it
      // in ONE write (the removed legacy flow needed append + a second UPDATE).
      const token = await mintToken(mergeUser)
      const res = await punch(token, {
        eventType: 'check_in', occurredAt: '2026-07-20T01:00:00.000Z', orgId: mergeOrg, source: 'manual',
      })
      expect(res.status).toBe(200)
      expect(await eventCount(mergeUser)).toBe(2)

      // Semantic half (a neutered merge fails here: first_in would stay 00:30).
      const rows = await recordRow(mergeUser)
      expect(rows.length).toBe(1)
      expect(new Date(rows[0].first_in_at as string | Date).toISOString()).toBe('2026-07-20T01:00:00.000Z')

      // Write-count half (a restored P02 second pass fails here with 2 rows).
      const audit = await pool.query(
        `SELECT op FROM ${AUDIT_TABLE} WHERE user_id = $1 ORDER BY at`,
        [mergeUser],
      )
      expect(audit.rows).toEqual([{ op: 'UPDATE' }])

      // Structurally-legacy org: the posture split holds here too.
      expect((await operationRows(mergeOrg)).length).toBe(0)
      expect((await calculationRowsForUser(mergeUser)).length).toBe(0)
      expect((await outboxRows(mergeOrg)).length).toBe(0)
    } finally {
      const disable = await requestJson(`${baseUrl}/api/attendance/settings`, {
        method: 'PUT',
        headers: authHeaders(adminToken),
        body: JSON.stringify({ punchPolicy: { merge: { internalWinsOnIn: false } } }),
      })
      expect(disable.status).toBe(200)
    }
  })

  // ---------------------------------------------------------------------
  // P1-4 remediation (#4612 gate finding, c-5082182541) — cron/admin_run
  // scheduled witness split. Direct boundary construction (own
  // createAttendanceLiveScheduledBoundaryV1 instance + real pool connection,
  // stub legacyAdapters) mirrors leg 5a-5d's direct-witness-construction
  // style rather than the HTTP route, so these legs prove the BOUNDARY's own
  // input-shape validation and witness minting, not route wiring.
  // ---------------------------------------------------------------------

  function throwingScheduledAdapters(): {
    adapters: AttendanceW4LiveScheduledLegacyAdaptersV1
    absenceCallCount: () => number
  } {
    let n = 0
    const unreached = (name: string) => async () => {
      throw new Error(`W4C2_P14_STUB_${name}_MUST_NOT_BE_REACHED`)
    }
    const adapters: AttendanceW4LiveScheduledLegacyAdaptersV1 = {
      applyLivePunchLegacy: unreached('applyLivePunchLegacy') as never,
      // Zero-effect ("nobody absent") but the CALL ITSELF is the signal a
      // rejection leg must never produce — counted, never a real INSERT.
      applyScheduledAbsenceLegacy: async () => {
        n += 1
        return []
      },
      resolveLiveCandidate: unreached('resolveLiveCandidate') as never,
      resolveScheduledCandidate: unreached('resolveScheduledCandidate') as never,
      buildShadowFrozenContext: unreached('buildShadowFrozenContext') as never,
    }
    return { adapters, absenceCallCount: () => n }
  }

  function buildDirectScheduledBoundary(adapters: AttendanceW4LiveScheduledLegacyAdaptersV1) {
    return createAttendanceLiveScheduledBoundaryV1({
      legacyAdapters: adapters,
      async acquireConnection(): Promise<AttendanceW4BoundaryConnectionV1> {
        const raw = await pool.connect()
        return {
          client: raw as unknown as AttendanceW4TransactionClientV1,
          release: () => raw.release(),
        }
      },
    })
  }

  it('P1-4 leg A — admin_run carrying the internal scheduler identity as its adminActorId is rejected at MINT, before any per-user transaction opens (zero absence-adapter calls; zero new operation rows)', async () => {
    const { adapters, absenceCallCount } = throwingScheduledAdapters()
    const boundary = buildDirectScheduledBoundary(adapters)
    const opsBefore = (await operationRows(adminWitnessOrg, 'scheduled')).length

    await expect(
      boundary.executeScheduledRun({
        orgId: adminWitnessOrg,
        workDate: '2026-07-10',
        timezone: 'UTC',
        targetUserIds: [adminWitnessTargetUser],
        initiator: 'admin_run',
        adminActorId: ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
      }),
    ).rejects.toMatchObject({ code: 'W4C2_SCHEDULED_ADMIN_WITNESS_INVALID' })

    expect(absenceCallCount()).toBe(0)
    expect((await operationRows(adminWitnessOrg, 'scheduled')).length).toBe(opsBefore)
    expect(await recordCount(adminWitnessTargetUser)).toBe(0)
  })

  it('P1-4 leg B — admin_run with a NEVER-REGISTERED admin identity is rejected before any source/result DML (zero rows); the identical call with a real active admin identity claims+seals the operation (positive control)', async () => {
    const { adapters, absenceCallCount } = throwingScheduledAdapters()
    const boundary = buildDirectScheduledBoundary(adapters)
    const workDate = '2026-07-11'
    const opsBefore = (await operationRows(adminWitnessOrg, 'scheduled')).length

    // Rejection half: adminWitnessStaleAdmin was deliberately never inserted
    // into `users` (module-scope note above) — the SAME shape a deactivated
    // or deprovisioned admin would produce.
    await expect(
      boundary.executeScheduledRun({
        orgId: adminWitnessOrg,
        workDate,
        timezone: 'UTC',
        targetUserIds: [adminWitnessTargetUser],
        initiator: 'admin_run',
        adminActorId: adminWitnessStaleAdmin,
      }),
    ).rejects.toMatchObject({ code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' })
    expect(absenceCallCount()).toBe(0)
    expect((await operationRows(adminWitnessOrg, 'scheduled')).length).toBe(opsBefore)
    expect((await calculationRowsForUser(adminWitnessTargetUser)).length).toBe(0)
    expect(await recordCount(adminWitnessTargetUser)).toBe(0)

    // Positive control: identical shape, adminWitnessRealAdmin IS a real
    // active `users` row — the per-user operation is claimed and sealed with
    // the real admin identity as actor_id (adapter reached exactly once).
    const result = await boundary.executeScheduledRun({
      orgId: adminWitnessOrg,
      workDate,
      timezone: 'UTC',
      targetUserIds: [adminWitnessTargetUser],
      initiator: 'admin_run',
      adminActorId: adminWitnessRealAdmin,
    })
    expect(result.kind).toBe('w4')
    expect(absenceCallCount()).toBe(1)
    const opsAfter = await operationRows(adminWitnessOrg, 'scheduled')
    expect(opsAfter.length).toBe(opsBefore + 1)
    const sealed = opsAfter.find((row) => row.proof_user_id === adminWitnessTargetUser && row.proof_work_date === workDate)
    expect(sealed).toMatchObject({
      state: 'completed',
      actor_id: adminWitnessRealAdmin,
      capability: 'scheduled',
    })
  })

  it('P1-4 leg C — cron carrying a non-null adminActorId is rejected before the posture probe (zero DB calls of any kind: a fresh org that was never given a rollout row still rejects)', async () => {
    const { adapters, absenceCallCount } = throwingScheduledAdapters()
    const boundary = buildDirectScheduledBoundary(adapters)
    // A brand-new org with NO rollout row at all — if this leg's rejection
    // required any DB read, a fresh UUID org key would take the structurally-
    // legacy branch instead of throwing (proving the rejection is truly
    // synchronous, ahead of every other check in the function).
    const untouchedOrg = randomUUID()

    await expect(
      boundary.executeScheduledRun({
        orgId: untouchedOrg,
        workDate: '2026-07-12',
        timezone: 'UTC',
        targetUserIds: [randomUUID()],
        initiator: 'cron',
        adminActorId: adminWitnessRealAdmin,
      }),
    ).rejects.toMatchObject({ code: 'W4C2_SCHEDULED_WITNESS_INITIATOR_MISMATCH' })

    expect(absenceCallCount()).toBe(0)
    expect((await operationRows(untouchedOrg, 'scheduled')).length).toBe(0)
  })
})
