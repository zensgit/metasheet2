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
  createAttendanceLiveScheduledBoundaryV1,
  AttendanceW4LiveScheduledBoundaryError,
  type AttendanceW4LiveScheduledLegacyAdaptersV1,
  type AttendanceW4BoundaryConnectionV1,
} from '../../src/attendance/w4c2-live-scheduled-boundary'
import { AttendanceW4OperationError } from '../../src/attendance/w4c0-operation-contract'
import {
  abandonAttendanceScheduledRunV1,
  createOrResumeAttendanceScheduledRunV1,
  requireAttendanceScheduledRunRunningBeforeSourceDmlV1,
} from '../../src/attendance/w4c2-scheduled-run'
import { dispatchAttendanceResultEventOutboxV1 } from '../../src/attendance/w4c2-outbox-dispatcher'
import { eventBus } from '../../src/integration/events/event-bus'

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
  // W4C-2 caller cutover (owner ruling 2026-07-28, "(b-narrow)") new-gate orgs
  // (leg 9g-9k) — each MUST be on the allowlist below (w4c0 posture doctrine:
  // persisted rollout row AND exact env entry) or it resolves structurally
  // `legacy_projection_only` regardless of the row this file inserts.
  const cutoverRestartOrg = randomUUID()
  const cutoverConcurrentOrg = randomUUID()
  const cutoverStragglerOrg = randomUUID()
  const cutoverStragglerControlOrg = randomUUID()
  const cutoverStragglerRaceOrg = randomUUID()
  const cutoverInitiatorOrg = randomUUID()
  const cutoverDispatchOrg = randomUUID()
  const cutoverRecoveryOrg = randomUUID()
  const cutoverAdminRecoveryOrg = randomUUID()
  // Gate 8 (owner ruling 2026-07-28, "(b-narrow)" required-gate list item 8):
  // an ALLOWLISTED org whose rollout row is `legacy` — resolves to
  // `legacy_projection_only` via `resolveSegmentCalculationPosture` (the
  // SAME branch, executeScheduledRun ~L1657, leg 7's live-punch analog
  // already exercises for punches) rather than the "never allowlisted"
  // `rolloutKey === null` shortcut `mergeOrg` uses — this makes the
  // mutation target for "misroute legacy to the new machine" a single,
  // precise line (the `posture.writePosture === 'legacy_projection_only'`
  // branch itself), not the org-key pre-classification above it.
  const cutoverLegacyOrg = randomUUID()

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
  const cutoverLegacyUser = randomUUID()
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
      `SELECT operation_id::text AS operation_id, entrypoint, state, accepted_write_posture, actor_id, capability, source_ref,
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
  /** A raw pool connection released after `body` settles — for direct-API constructions below. */
  async function withConnDirect<T>(body: (client: unknown) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      return await body(client)
    } finally {
      client.release()
    }
  }
  /** W4C-2 caller cutover (owner ruling 2026-07-28, "(b-narrow)") new-gate helper. */
  const scheduledRunRows = async (orgId: string, workDate?: string) =>
    (await pool.query(
      `SELECT run_id::text AS run_id, initiator, work_date::text AS work_date, generation, state,
              expected_user_count, review_count, completed_user_count, generated_count
         FROM attendance_scheduled_runs
        WHERE org_id = $1 AND ($2::date IS NULL OR work_date = $2::date)
        ORDER BY generation ASC`,
      [orgId, workDate ?? null],
    )).rows
  const scheduledRunOutboxRows = async (orgId: string) =>
    (await pool.query(
      `SELECT id::text AS id, scheduled_run_id::text AS scheduled_run_id, event_kind, payload, delivery_state
         FROM attendance_result_event_outbox
        WHERE org_id = $1 AND identity_kind = 'scheduled_run' ORDER BY created_at`,
      [orgId],
    )).rows
  /**
   * A "real" (not throwing-stub) scheduled legacy adapter set for the caller-
   * cutover gates below: `applyScheduledAbsenceLegacy` performs the SAME
   * NOT-EXISTS-guarded absence INSERT `generateAbsenceRecords`
   * (plugins/plugin-attendance/index.cjs) does, over the plugin-shaped
   * `trx.query` wrapper; `resolveScheduledCandidate` always reports
   * `unresolved` (the calculation-engine half is out of scope for these
   * wiring gates — `attributionFromResolution` maps it to a closed
   * `unsupported` review, never a crash, never `buildShadowFrozenContext`).
   */
  function realScheduledAdapters(): {
    adapters: AttendanceW4LiveScheduledLegacyAdaptersV1
    absenceCallCount: () => number
    absenceCallUserIds: () => string[]
  } {
    let n = 0
    const seenUserIds: string[] = []
    const unreached = (name: string) => async () => {
      throw new Error(`W4C2_CUTOVER_STUB_${name}_MUST_NOT_BE_REACHED`)
    }
    const adapters: AttendanceW4LiveScheduledLegacyAdaptersV1 = {
      applyLivePunchLegacy: unreached('applyLivePunchLegacy') as never,
      applyScheduledAbsenceLegacy: async (trx, args) => {
        n += 1
        seenUserIds.push(...args.userIds)
        return trx.query(
          `INSERT INTO attendance_records
             (user_id, org_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes, status, is_workday, created_at, updated_at)
           SELECT uo.user_id, $2, $1, $3, 0, 0, 0, 'absent', true, now(), now()
           FROM user_orgs uo
           JOIN users u ON u.id = uo.user_id
           WHERE uo.org_id = $2 AND uo.is_active = true AND u.is_active = true
             AND uo.user_id = ANY($4)
             AND NOT EXISTS (
               SELECT 1 FROM attendance_records r
               WHERE r.user_id = uo.user_id AND r.work_date = $1 AND r.org_id = $2
             )
           RETURNING user_id`,
          [args.workDate, args.orgId, args.timezone, args.userIds],
        ) as unknown as Promise<Array<{ user_id: string }>>
      },
      resolveLiveCandidate: unreached('resolveLiveCandidate') as never,
      resolveScheduledCandidate: async () => ({ kind: 'unresolved' }),
      buildShadowFrozenContext: unreached('buildShadowFrozenContext') as never,
    }
    return { adapters, absenceCallCount: () => n, absenceCallUserIds: () => seenUserIds.slice() }
  }

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
    // Fixture-only run id: this helper builds a module-level preflight
    // envelope shape (leg 5c/5d), not a durable run — any well-formed UUID
    // serves; the durable `run_id` is now always server-minted (see leg 9).
    const runId = randomUUID()
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
      cutoverRestartOrg, cutoverConcurrentOrg, cutoverStragglerOrg, cutoverStragglerControlOrg,
      cutoverStragglerRaceOrg, cutoverInitiatorOrg, cutoverDispatchOrg, cutoverRecoveryOrg,
      cutoverAdminRecoveryOrg, cutoverLegacyOrg,
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

  it('leg 9 — durable scheduled-run: the real admin_run entry point creates a durable run whose server-minted run_id anchors the sealed operation; a repeat administrator call after completion is idempotent at the data layer across a NEW generation (ratified OD-W4C-45=(a) cross-generation cost); W2-ambiguous user gets no parent/result; skipDedup cannot bypass the registry', async () => {
    // W4C-2 remediation P1-4 (#4612 gate finding): admin_run now mints its
    // witness from the ROUTE's real authenticated actor id (platform_admin
    // posture, requireActiveUser only — see adminRunScheduledAuthorization's
    // module comment), so the admin token's subject must be a real active
    // `users` row (inserted in beforeAll) or the in-transaction recheck 403s
    // before any source DML.
    const adminToken = await mintToken(schedAdminUser, 'attendance:read,attendance:write,attendance:admin')
    const workDate = '2026-07-22'

    // W4C-2 caller cutover (owner ruling 2026-07-28, "(b-narrow)") — owner red
    // line: for shadow/eligible/authoritative, run-level events go ONLY
    // through the dispatcher; `runAutoAbsenceForOrgDate`'s own synchronous
    // `emit(...)` calls must NOT ALSO fire. Subscribed on the real,
    // process-wide event bus the route's `emitEvent` writes to
    // (`context.api.events.emit` -> this exact singleton) — a caught
    // regression here is not a mock's opinion of the wiring.
    const directEmits: Array<{ type: string; payload: unknown }> = []
    const absenceSubId = eventBus.subscribe('attendance.absence.generated', (payload) => {
      directEmits.push({ type: 'attendance.absence.generated', payload })
    })
    const reviewSubId = eventBus.subscribe('attendance.work_date.review_required', (payload) => {
      directEmits.push({ type: 'attendance.work_date.review_required', payload })
    })

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

    // The durable run row itself: server-minted run_id (generation 1),
    // completed with the expected folded counts.
    const runsAfterFirst = await scheduledRunRows(schedOrg, workDate)
    expect(runsAfterFirst.length).toBe(1)
    expect(runsAfterFirst[0]).toMatchObject({
      initiator: 'admin_run',
      generation: 1,
      state: 'completed',
      expected_user_count: 1,
      review_count: 1,
      completed_user_count: 1,
      generated_count: 1,
    })
    const firstRunId = runsAfterFirst[0].run_id

    const opsAfterFirst = await operationRows(schedOrg, 'scheduled')
    expect(opsAfterFirst.length).toBe(1)
    expect(opsAfterFirst[0]).toMatchObject({
      state: 'completed',
      accepted_write_posture: 'shadow',
      identity_source_kind: 'scheduled',
      // The operation's source_root_id anchors to the run this file's OWN
      // durable-run query just read back — never a value pre-derived by a
      // pure function of (initiator, orgId, workDate); that derivation
      // (`deriveAttendanceScheduledRunIdV1`) was retired by the caller
      // cutover (owner ruling 2026-07-28, "(b-narrow)").
      source_root_id: firstRunId,
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
    // (skipDedup:true). Generation 1 already left `running` (it is
    // `completed`), so `createOrResumeAttendanceScheduledRunV1` does not
    // resume it — per section 1.7 step 3 ("if a `running` row exists, this
    // is a resume; otherwise ... allocate `generation`") a SECOND terminal-
    // then-repeated call for the SAME (org, initiator, workDate) mints a NEW
    // generation, ratified as `OD-W4C-45=(a)`'s accepted cross-generation
    // cost (amendment's own "Declared residuals": every per-user
    // `operation_id` derives from `(run_id, user_id, work_date)`, so a new
    // `run_id` means a genuinely new operation identity for generation 2 —
    // never a replay of generation 1's operation). The absence INSERT stays
    // guarded by `NOT EXISTS` regardless (data-layer idempotency,
    // independent of the run-identity layer), so the OBSERVABLE response is
    // unchanged from the pre-cutover behavior this leg originally pinned:
    // `generated: 0, total: 0`, and schedUser's `attendance_records`/
    // `attendance_record_calculations` row counts stay exactly 1.
    const second = await autoAbsenceRun(adminToken, { orgId: schedOrg, workDate })
    expect(second.status).toBe(200)
    expect(second.body?.data).toMatchObject({ skipped: false, generated: 0, total: 0 })
    expect(await recordCount(schedUser)).toBe(1)

    const runsAfterSecond = await scheduledRunRows(schedOrg, workDate)
    expect(runsAfterSecond.length).toBe(2)
    expect(runsAfterSecond[1]).toMatchObject({
      initiator: 'admin_run',
      generation: 2,
      state: 'completed',
      expected_user_count: 1,
      review_count: 1,
      completed_user_count: 1,
      // The absence row already exists (generation 1's), so generation 2's
      // own INSERT..SELECT NOT EXISTS inserts nothing.
      generated_count: 0,
    })
    expect(runsAfterSecond[1].run_id).not.toBe(firstRunId)

    const opsAfterSecond = await operationRows(schedOrg, 'scheduled')
    expect(opsAfterSecond.length).toBe(2)
    const secondOp = opsAfterSecond.find((row) => row.operation_id !== firstOperationId)
    expect(secondOp).toMatchObject({
      state: 'completed',
      accepted_write_posture: 'shadow',
      source_root_id: runsAfterSecond[1].run_id,
      proof_user_id: schedUser,
      proof_work_date: workDate,
      response_snapshot: { inserted: false },
    })
    // Generation 2's `inserted: false` means the shadow-calculation branch
    // never runs (`if (inserted) { ... }`) — schedUser's calculation count
    // stays exactly the ONE generation-1 row.
    expect((await calculationRowsForUser(schedUser)).length).toBe(1)
    expect(await recordCount(schedAmbUser)).toBe(0)

    // The owner red line itself: across BOTH real admin_run calls (one
    // `created_and_finalized`-adjacent full run, one cross-generation
    // replay), `runAutoAbsenceForOrgDate`'s own synchronous `emit(...)` never
    // fired for this shadow-posture org — the two durable run-level outbox
    // rows (asserted via leg 9k's own dispatcher drain) are the only path.
    eventBus.unsubscribe(absenceSubId)
    eventBus.unsubscribe(reviewSubId)
    expect(directEmits).toEqual([])
  })

  // -------------------------------------------------------------------------
  // W4C-2 caller cutover (owner ruling 2026-07-28, "(b-narrow)") — new
  // required gates: restart resume, concurrent same run, straggler
  // (gate 12 pre-DML fail-closed), two initiator types, two run-level events
  // exactly-once via dispatcher. Direct boundary construction (own
  // `createAttendanceLiveScheduledBoundaryV1` instance + real pool
  // connection), matching the established P1-4 legs' style above — this
  // proves the BOUNDARY's own wiring, driven through its one real production
  // entry point (`executeScheduledRun`), independent of route reachability.
  // -------------------------------------------------------------------------

  function onceFailingAdapters(failUserId: string): {
    adapters: AttendanceW4LiveScheduledLegacyAdaptersV1
    absenceCallUserIds: () => string[]
  } {
    const real = realScheduledAdapters()
    let failed = false
    const adapters: AttendanceW4LiveScheduledLegacyAdaptersV1 = {
      ...real.adapters,
      applyScheduledAbsenceLegacy: async (trx, args) => {
        if (!failed && args.userIds.includes(failUserId)) {
          failed = true
          throw new Error('W4C2_CUTOVER_SIMULATED_CRASH')
        }
        return real.adapters.applyScheduledAbsenceLegacy(trx, args)
      },
    }
    return { adapters, absenceCallUserIds: real.absenceCallUserIds }
  }

  it('leg 9g — restart/partial-completion: a crash after k of n users commit resumes the SAME run from durable evidence on retry; the already-terminal user replays with zero new DML, the crashed user completes on retry, folded counts equal an uninterrupted control', async () => {
    const orgId = cutoverRestartOrg
    const userA = randomUUID()
    const userB = randomUUID()
    await insertRolloutRow(orgId, 'shadow')
    await insertActiveUser(userA, orgId)
    await insertActiveUser(userB, orgId)
    const workDate = '2026-03-01'

    const { adapters, absenceCallUserIds } = onceFailingAdapters(userB)
    const boundary = buildDirectScheduledBoundary(adapters)
    const call = () =>
      boundary.executeScheduledRun({
        orgId,
        workDate,
        timezone: 'UTC',
        targetUserIds: [userA, userB],
        reviewTargets: [],
        initiator: 'cron',
        adminActorId: null,
        // A process-local duplicate signal must never hide a W4 running run.
        // Both the crash and retry therefore continue through class-01.
        legacyDedupHit: true,
      })

    // First attempt: userA commits (real INSERT), userB's per-user
    // transaction throws BEFORE its own commit (simulated crash) — the whole
    // call rejects, but userA's work is durable (own, already-committed
    // transaction), never rolled back by userB's failure. The failing stub
    // throws BEFORE delegating to the real adapter, so only the SUCCEEDED
    // call (userA) is recorded here — userB's crashed attempt never reached
    // the real absence INSERT at all (proven independently below by the
    // operation-row count staying at 1).
    await expect(call()).rejects.toThrow('W4C2_CUTOVER_SIMULATED_CRASH')
    expect(absenceCallUserIds()).toEqual([userA])

    const runsAfterCrash = await scheduledRunRows(orgId, workDate)
    expect(runsAfterCrash.length).toBe(1)
    expect(runsAfterCrash[0]).toMatchObject({ generation: 1, state: 'running' })
    const opsAfterCrash = await operationRows(orgId, 'scheduled')
    expect(opsAfterCrash.length).toBe(1)
    expect(opsAfterCrash[0].proof_user_id).toBe(userA)
    const userARowBeforeRetry = opsAfterCrash[0]

    // Retry (a freshly restarted process would call this exact same shape —
    // `runAutoAbsenceForOrgDate` re-resolves the SAME membership and calls
    // the boundary again): resumes generation 1 (NOT a new generation, since
    // it is still `running`), replays userA with zero new DML, and completes
    // ONLY userB this time.
    const retry = await call()
    expect(retry.kind).toBe('w4')
    expect(retry.runId).toBe(runsAfterCrash[0].run_id)
    // userA's absence adapter is NOT called again — the resume protocol
    // derives its work list from `outstandingGenerateTargets` (targets with
    // no row yet in `attendance_scheduled_run_target_outcomes`), which
    // excludes the already-terminal userA entirely; only userB (this time
    // not forced to throw) is attempted.
    expect(absenceCallUserIds()).toEqual([userA, userB])

    const runsAfterRetry = await scheduledRunRows(orgId, workDate)
    expect(runsAfterRetry.length).toBe(1)
    expect(runsAfterRetry[0]).toMatchObject({
      generation: 1,
      state: 'completed',
      expected_user_count: 2,
      completed_user_count: 2,
      generated_count: 2,
    })
    const opsAfterRetry = await operationRows(orgId, 'scheduled')
    expect(opsAfterRetry.length).toBe(2)
    // userA's row is byte-congruent with its pre-retry snapshot (same
    // operation_id, same sealed content) — the replay wrote nothing new.
    const userARowAfterRetry = opsAfterRetry.find((row) => row.proof_user_id === userA)
    expect(userARowAfterRetry).toEqual(userARowBeforeRetry)
    const userBRow = opsAfterRetry.find((row) => row.proof_user_id === userB)
    expect(userBRow).toMatchObject({ state: 'completed', proof_work_date: workDate })
  })

  it('leg 9g-recovery — a fresh boundary resumes the exact stranded run and never allocates generation n+1', async () => {
    const orgId = cutoverRecoveryOrg
    const userA = randomUUID()
    const userB = randomUUID()
    await insertRolloutRow(orgId, 'shadow')
    await insertActiveUser(userA, orgId)
    await insertActiveUser(userB, orgId)
    const workDate = '2026-03-07'

    const firstAdapters = onceFailingAdapters(userB)
    const firstBoundary = buildDirectScheduledBoundary(firstAdapters.adapters)
    await expect(
      firstBoundary.executeScheduledRun({
        orgId,
        workDate,
        timezone: 'UTC',
        targetUserIds: [userA, userB],
        reviewTargets: [],
        initiator: 'cron',
        adminActorId: null,
      }),
    ).rejects.toThrow('W4C2_CUTOVER_SIMULATED_CRASH')

    const stranded = await scheduledRunRows(orgId, workDate)
    expect(stranded).toHaveLength(1)
    expect(stranded[0]).toMatchObject({ generation: 1, state: 'running' })
    const runId = stranded[0].run_id as string

    // A fresh boundary instance stands in for a restarted process. The worker callback carries
    // the scanned run id into the recovery-only entry, so it cannot fall back to ordinary
    // create-or-resume generation allocation.
    const recoveryAdapters = realScheduledAdapters()
    const recoveryBoundary = buildDirectScheduledBoundary(recoveryAdapters.adapters)
    await recoveryBoundary.recoverScheduledRun({
      orgId,
      workDate,
      timezone: 'UTC',
      targetUserIds: [userA, userB],
      reviewTargets: [],
      initiator: 'cron',
      runId,
    })

    const after = await scheduledRunRows(orgId, workDate)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      run_id: runId,
      generation: 1,
      state: 'completed',
      expected_user_count: 2,
      completed_user_count: 2,
      generated_count: 2,
    })
    expect((await operationRows(orgId, 'scheduled'))).toHaveLength(2)
    expect(await recordCount(userA)).toBe(1)
    expect(await recordCount(userB)).toBe(1)
    // Only the outstanding user is executed by the recovery boundary.
    expect(recoveryAdapters.absenceCallUserIds()).toEqual([userB])

    // Scan/finalize race: the same stale candidate reaches recovery after another worker has
    // already completed it. The exact-run entry is a zero-DML no-op; routing this through the
    // ordinary create-or-resume entry would allocate generation 2 and this assertion would fail.
    await recoveryBoundary.recoverScheduledRun({
      orgId,
      workDate,
      timezone: 'UTC',
      targetUserIds: [userA, userB],
      reviewTargets: [],
      initiator: 'cron',
      runId,
    })
    expect(await scheduledRunRows(orgId, workDate)).toHaveLength(1)
    expect(recoveryAdapters.absenceCallUserIds()).toEqual([userB])
  })

  it('leg 9g-admin-recovery — the registered service identity resumes an admin_run without fabricating a human actor', async () => {
    const orgId = cutoverAdminRecoveryOrg
    const userA = randomUUID()
    const userB = randomUUID()
    await insertRolloutRow(orgId, 'shadow')
    await insertActiveUser(userA, orgId)
    await insertActiveUser(userB, orgId)
    const workDate = '2026-03-08'

    const firstAdapters = onceFailingAdapters(userB)
    const firstBoundary = buildDirectScheduledBoundary(firstAdapters.adapters)
    await expect(
      firstBoundary.executeScheduledRun({
        orgId,
        workDate,
        timezone: 'UTC',
        targetUserIds: [userA, userB],
        reviewTargets: [],
        initiator: 'admin_run',
        adminActorId: schedAdminUser,
      }),
    ).rejects.toThrow('W4C2_CUTOVER_SIMULATED_CRASH')
    const run = (await scheduledRunRows(orgId, workDate))[0]
    expect(run).toMatchObject({ initiator: 'admin_run', generation: 1, state: 'running' })

    const recoveryAdapters = realScheduledAdapters()
    const recoveryBoundary = buildDirectScheduledBoundary(recoveryAdapters.adapters)
    await recoveryBoundary.recoverScheduledRun({
      orgId,
      workDate,
      timezone: 'UTC',
      targetUserIds: [userA, userB],
      reviewTargets: [],
      initiator: 'admin_run',
      runId: run.run_id,
    })

    expect(await scheduledRunRows(orgId, workDate)).toMatchObject([
      { run_id: run.run_id, initiator: 'admin_run', generation: 1, state: 'completed' },
    ])
    const operations = await operationRows(orgId, 'scheduled')
    expect(operations.find((row) => row.proof_user_id === userA)?.actor_id).toBe(schedAdminUser)
    expect(operations.find((row) => row.proof_user_id === userB)?.actor_id).toBe(
      ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1,
    )
    expect(operations.find((row) => row.proof_user_id === userB)?.source_ref).toBe(
      'plugin-attendance:auto-absence:recovery-sweep',
    )
    expect(recoveryAdapters.absenceCallUserIds()).toEqual([userB])
  })

  it('leg 9h — concurrent same run: two simultaneous calls for the SAME (org, initiator, workDate) never duplicate the run row, the target row, or the absence insert; exactly one run, one operation, one record survive', async () => {
    const orgId = cutoverConcurrentOrg
    const userA = randomUUID()
    await insertRolloutRow(orgId, 'shadow')
    await insertActiveUser(userA, orgId)
    const workDate = '2026-03-02'

    const { adapters } = realScheduledAdapters()
    const boundary = buildDirectScheduledBoundary(adapters)
    const call = () =>
      boundary.executeScheduledRun({
        orgId,
        workDate,
        timezone: 'UTC',
        targetUserIds: [userA],
        reviewTargets: [],
        initiator: 'cron',
        adminActorId: null,
      })

    const [first, second] = await Promise.all([call(), call()])
    expect(first.kind).toBe('w4')
    expect(second.kind).toBe('w4')
    if (first.kind !== 'w4' || second.kind !== 'w4') throw new Error('unreachable')
    // Both racers converge on the SAME durable run — the class-01 lock plus
    // the `state='running'` resume predicate serializes them (w4c2-scheduled-
    // run.ts section 1.7), never two independent generation-1 rows.
    expect(second.runId).toBe(first.runId)

    const runs = await scheduledRunRows(orgId, workDate)
    expect(runs.length).toBe(1)
    expect(runs[0]).toMatchObject({ generation: 1, state: 'completed', expected_user_count: 1, generated_count: 1 })
    const ops = await operationRows(orgId, 'scheduled')
    expect(ops.length).toBe(1)
    expect(await recordCount(userA)).toBe(1)
  })

  it('leg 9i — straggler (gate 12, first half): a per-user operation transaction whose durable run is abandoned before it reaches source DML is rejected BEFORE the absence INSERT — the writer-side check (recordAttendanceScheduledRunTargetOutcomeV1) is not the only door', async () => {
    const orgId = cutoverStragglerOrg
    const userA = randomUUID()
    await insertRolloutRow(orgId, 'shadow')
    await insertActiveUser(userA, orgId)
    const workDate = '2026-03-03'

    // Build a running run directly (bypassing the boundary), matching the
    // p12-run-transactions.db.test.ts direct-API style, so the abandon can
    // land BEFORE any per-user transaction ever opens — the deterministic
    // shape of the race this check exists for (an operator abandons a run
    // between its per-user transactions; section 1.7's fail-closed rule).
    const created = await withConnDirect(async (client) =>
      runAttendanceResultOperationTransactionV1(client as unknown as AttendanceW4TransactionClientV1, (trx) =>
        createOrResumeAttendanceScheduledRunV1(
          trx,
          { orgId, initiator: 'cron', workDate },
          async () => [{ userId: userA, targetKind: 'generate', reviewReasonCode: null }],
        ),
      ),
    )
    if (created.kind !== 'created_running') throw new Error('expected created_running')

    const abandonCaller = createAuthorizedAttendanceWriteContextV1({
      actorId: 'w4c2-e5-cutover-operator',
      actorPosture: 'platform_admin',
      tokenSubjectUserId: 'w4c2-e5-cutover-operator',
      orgId,
      subjectScope: { kind: 'explicit_users', userIds: ['w4c2-e5-cutover-operator'] },
      capability: 'retirement',
      sourceRef: 'w4c2-e5:leg9i-straggler-abandon',
    })
    const abandoned = await withConnDirect(async (client) =>
      runAttendanceResultOperationTransactionV1(client as unknown as AttendanceW4TransactionClientV1, (trx) =>
        abandonAttendanceScheduledRunV1(
          trx,
          abandonCaller,
          { orgId, runId: created.runId },
          'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
        ),
      ),
    )
    expect(abandoned.kind).toBe('abandoned')

    // The straggler: a per-user operation transaction for userA that reaches
    // this run's per-user machinery AFTER the abandon already committed.
    // `requireAttendanceScheduledRunRunningBeforeSourceDmlV1` is exercised
    // exactly as the boundary calls it — before any source DML — over the
    // SAME `runId` the abandoned row now carries.
    const { adapters, absenceCallCount } = realScheduledAdapters()
    let rejected: unknown
    await withConnDirect(async (client) =>
      runAttendanceResultOperationTransactionV1(client as unknown as AttendanceW4TransactionClientV1, async (trx) => {
        try {
          await requireAttendanceScheduledRunRunningBeforeSourceDmlV1(trx, orgId, created.runId)
        } catch (error) {
          rejected = error
        }
      }),
    )
    expect(String((rejected as { code?: string })?.code)).toBe('W4C2_SCHEDULED_RUN_NOT_RUNNING_BEFORE_SOURCE_DML')
    // The negative control this leg's own name requires: a 'running' run's
    // check passes (zero throw) — proving the rejection above is
    // discriminating on run state, not a guard that always fires.
    const runningOrgId = cutoverStragglerControlOrg
    const runningUser = randomUUID()
    await insertRolloutRow(runningOrgId, 'shadow')
    await insertActiveUser(runningUser, runningOrgId)
    const runningCreated = await withConnDirect(async (client) =>
      runAttendanceResultOperationTransactionV1(client as unknown as AttendanceW4TransactionClientV1, (trx) =>
        createOrResumeAttendanceScheduledRunV1(
          trx,
          { orgId: runningOrgId, initiator: 'cron', workDate },
          async () => [{ userId: runningUser, targetKind: 'generate', reviewReasonCode: null }],
        ),
      ),
    )
    if (runningCreated.kind !== 'created_running') throw new Error('expected created_running')
    let passed = false
    await withConnDirect(async (client) =>
      runAttendanceResultOperationTransactionV1(client as unknown as AttendanceW4TransactionClientV1, async (trx) => {
        await requireAttendanceScheduledRunRunningBeforeSourceDmlV1(trx, runningOrgId, runningCreated.runId)
        passed = true
      }),
    )
    expect(passed).toBe(true)
    // Zero absence-adapter calls: this leg never drives the boundary's own
    // for-loop (it exercises the check in isolation, over real committed
    // rows), so the counting stub confirms nothing extraneous ran.
    expect(absenceCallCount()).toBe(0)
  })

  it('leg 9l — straggler, through the boundary\'s own per-user transaction: a genuinely concurrent abandon (a separate connection, racing against an in-flight per-user transaction) makes the SERIALIZABLE per-user transaction retry and, on retry, the pre-DML check observes the run is no longer running and rejects BEFORE the absence INSERT — a real interleaving, not a synthetic call', async () => {
    const orgId = cutoverStragglerRaceOrg
    const userA = randomUUID()
    const userB = randomUUID()
    await insertRolloutRow(orgId, 'shadow')
    await insertActiveUser(userA, orgId)
    await insertActiveUser(userB, orgId)
    const workDate = '2026-03-06'

    let absenceCalls = 0
    const adapters: AttendanceW4LiveScheduledLegacyAdaptersV1 = {
      applyLivePunchLegacy: async () => { throw new Error('unreached') },
      resolveLiveCandidate: async () => { throw new Error('unreached') },
      resolveScheduledCandidate: async () => ({ kind: 'unresolved' }),
      buildShadowFrozenContext: async () => { throw new Error('unreached') },
      applyScheduledAbsenceLegacy: async (trx, args) => {
        absenceCalls += 1
        const result = await trx.query(
          `INSERT INTO attendance_records
             (user_id, org_id, work_date, timezone, work_minutes, late_minutes, early_leave_minutes, status, is_workday, created_at, updated_at)
           SELECT uo.user_id, $2, $1, $3, 0, 0, 0, 'absent', true, now(), now()
           FROM user_orgs uo
           JOIN users u ON u.id = uo.user_id
           WHERE uo.org_id = $2 AND uo.is_active = true AND u.is_active = true
             AND uo.user_id = ANY($4)
             AND NOT EXISTS (
               SELECT 1 FROM attendance_records r
               WHERE r.user_id = uo.user_id AND r.work_date = $1 AND r.org_id = $2
             )
           RETURNING user_id`,
          [args.workDate, args.orgId, args.timezone, args.userIds],
        )
        // The side-effect that constructs the real race: as soon as userA's
        // OWN absence INSERT has run (still inside userA's own open
        // SERIALIZABLE transaction), a genuinely SEPARATE connection commits
        // an `abandonAttendanceScheduledRunV1` transition for this run. This
        // is real, awaited, cross-connection concurrency — not two calls in
        // sequence — so PostgreSQL's own SSI conflict detection decides how
        // userA's transaction resolves, not this test's control flow.
        if (args.userIds[0] === userA) {
          const abandonCaller = createAuthorizedAttendanceWriteContextV1({
            actorId: 'w4c2-e5-cutover-race-operator',
            actorPosture: 'platform_admin',
            tokenSubjectUserId: 'w4c2-e5-cutover-race-operator',
            orgId,
            subjectScope: { kind: 'explicit_users', userIds: ['w4c2-e5-cutover-race-operator'] },
            capability: 'retirement',
            sourceRef: 'w4c2-e5:leg9l-straggler-race',
          })
          await withConnDirect(async (raceClient) => {
            const runRow = await pool.query(
              `SELECT run_id::text AS run_id FROM attendance_scheduled_runs
                WHERE org_id = $1 AND work_date = $2::date AND state = 'running'`,
              [orgId, workDate],
            )
            const runId = runRow.rows[0].run_id as string
            const abandonOutcome = await runAttendanceResultOperationTransactionV1(
              raceClient as unknown as AttendanceW4TransactionClientV1,
              (raceTrx) =>
                abandonAttendanceScheduledRunV1(
                  raceTrx,
                  abandonCaller,
                  { orgId, runId },
                  'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
                ),
            )
            expect(abandonOutcome.kind).toBe('abandoned')
          })
        }
        return result
      },
    }
    const boundary = buildDirectScheduledBoundary(adapters)

    let rejected: unknown
    try {
      await boundary.executeScheduledRun({
        orgId,
        workDate,
        timezone: 'UTC',
        targetUserIds: [userA, userB],
        reviewTargets: [],
        initiator: 'cron',
        adminActorId: null,
      })
    } catch (error) {
      rejected = error
    }
    expect(String((rejected as { code?: string })?.code)).toBe('W4C2_SCHEDULED_RUN_NOT_RUNNING_BEFORE_SOURCE_DML')

    // Zero durable evidence of a completed operation survives: userA's
    // insert ran inside a transaction that never committed (the concurrent
    // abandon forced a serialization retry, and the retry's own pre-DML
    // check rejected before any further DML), and userB was never reached
    // at all (the for-loop breaks on userA's exception) — this run stays
    // `abandoned` with zero operations, exactly like an operator-initiated
    // abandon of any other in-flight run.
    const runs = await scheduledRunRows(orgId, workDate)
    expect(runs.length).toBe(1)
    expect(runs[0]).toMatchObject({ generation: 1, state: 'abandoned', completed_user_count: 0 })
    expect((await operationRows(orgId, 'scheduled')).length).toBe(0)
    expect(await recordCount(userA)).toBe(0)
    expect(await recordCount(userB)).toBe(0)
    // Exactly one absence-adapter call total: userA's own (its transaction's
    // serialization retry re-runs userA's per-user transaction body, but the
    // retry's pre-DML check rejects BEFORE reaching the adapter again), and
    // userB is never attempted.
    expect(absenceCalls).toBe(1)
  })

  it('leg 9j — two initiator types: cron and admin_run for the SAME (org, workDate) are INDEPENDENT durable runs (initiator is part of the run key) — neither blocks, replays, or corrupts the other', async () => {
    const orgId = cutoverInitiatorOrg
    const userA = randomUUID()
    const adminActor = randomUUID()
    await insertRolloutRow(orgId, 'shadow')
    await insertActiveUser(userA, orgId)
    await insertActiveUser(adminActor, orgId)
    const workDate = '2026-03-04'

    const { adapters, absenceCallCount } = realScheduledAdapters()
    const boundary = buildDirectScheduledBoundary(adapters)

    const cronResult = await boundary.executeScheduledRun({
      orgId,
      workDate,
      timezone: 'UTC',
      targetUserIds: [userA],
      reviewTargets: [],
      initiator: 'cron',
      adminActorId: null,
    })
    const adminResult = await boundary.executeScheduledRun({
      orgId,
      workDate,
      timezone: 'UTC',
      targetUserIds: [userA],
      reviewTargets: [],
      initiator: 'admin_run',
      adminActorId: adminActor,
    })
    expect(cronResult.kind).toBe('w4')
    expect(adminResult.kind).toBe('w4')
    if (cronResult.kind !== 'w4' || adminResult.kind !== 'w4') throw new Error('unreachable')
    expect(cronResult.runId).not.toBe(adminResult.runId)

    const runs = await scheduledRunRows(orgId, workDate)
    expect(runs.length).toBe(2)
    expect(runs.map((r) => r.initiator).sort()).toEqual(['admin_run', 'cron'])
    for (const run of runs) {
      expect(run).toMatchObject({ generation: 1, state: 'completed', expected_user_count: 1 })
    }
    // Both initiators' operations target the SAME userA/workDate but are
    // TWO DISTINCT operations (different `operation_id`, since it derives
    // from `(run_id, userId, workDate)` and the two runs have different
    // `run_id`s) — the absence row itself stays singular (NOT EXISTS), so
    // only the FIRST-processed initiator's call actually inserts it.
    const ops = await operationRows(orgId, 'scheduled')
    expect(ops.length).toBe(2)
    expect(new Set(ops.map((o) => o.operation_id)).size).toBe(2)
    expect(await recordCount(userA)).toBe(1)
    expect(absenceCallCount()).toBe(2)
  })

  it('leg 9k — two run-level events exactly-once via the dispatcher: draining the SAME real run twice delivers `attendance.absence.generated` and `attendance.work_date.review_required` exactly once each, never twice, never via direct emit', async () => {
    const orgId = cutoverDispatchOrg
    const userGenerate = randomUUID()
    const reviewUser = randomUUID()
    await insertRolloutRow(orgId, 'shadow')
    await insertActiveUser(userGenerate, orgId)
    const workDate = '2026-03-05'

    const { adapters } = realScheduledAdapters()
    const boundary = buildDirectScheduledBoundary(adapters)
    const result = await boundary.executeScheduledRun({
      orgId,
      workDate,
      timezone: 'UTC',
      targetUserIds: [userGenerate],
      reviewTargets: [{ userId: reviewUser, reasonCode: 'WORK_DATE_ATTRIBUTION_AMBIGUOUS' }],
      initiator: 'cron',
      adminActorId: null,
    })
    expect(result.kind).toBe('w4')

    // Finalization already committed both run-level rows to the outbox
    // (never via a direct `emit(...)` — this direct-boundary construction
    // path has no caller-side emit at all to accidentally double-fire).
    const pendingBefore = await scheduledRunOutboxRows(orgId)
    expect(pendingBefore.length).toBe(2)
    expect(pendingBefore.map((r) => r.event_kind).sort()).toEqual([
      'attendance.absence.generated',
      'attendance.work_date.review_required',
    ])
    expect(pendingBefore.every((r) => r.delivery_state === 'pending')).toBe(true)

    const delivered: Array<{ eventKind: string; payload: unknown }> = []
    const raw = await pool.connect()
    try {
      const outcome = await dispatchAttendanceResultEventOutboxV1(raw as unknown as AttendanceW4TransactionClientV1, {
        emit: async (delivery) => {
          delivered.push({ eventKind: delivery.eventKind, payload: delivery.payload })
        },
      })
      expect(outcome.delivered).toBeGreaterThanOrEqual(2)
    } finally {
      raw.release()
    }
    const ourDeliveries = delivered.filter(
      (d) => (d.payload as { orgId?: string })?.orgId === orgId,
    )
    expect(ourDeliveries.length).toBe(2)
    const absenceEvent = ourDeliveries.find((d) => d.eventKind === 'attendance.absence.generated')
    expect(absenceEvent?.payload).toMatchObject({ orgId, workDate, total: 1 })
    const reviewEvent = ourDeliveries.find((d) => d.eventKind === 'attendance.work_date.review_required')
    expect(reviewEvent?.payload).toMatchObject({
      orgId,
      workDate,
      total: 1,
      reasons: [{ userId: reviewUser, reasonCode: 'WORK_DATE_ATTRIBUTION_AMBIGUOUS' }],
    })

    // A second drain delivers NOTHING further for this org — the one-way
    // pending -> delivered state machine, not a re-send.
    const raw2 = await pool.connect()
    try {
      const secondDelivered: unknown[] = []
      await dispatchAttendanceResultEventOutboxV1(raw2 as unknown as AttendanceW4TransactionClientV1, {
        emit: async (delivery) => { secondDelivered.push(delivery) },
      })
      expect(secondDelivered.filter((d: any) => d.payload?.orgId === orgId).length).toBe(0)
    } finally {
      raw2.release()
    }
    const pendingAfter = await scheduledRunOutboxRows(orgId)
    expect(pendingAfter.every((r) => r.delivery_state === 'delivered')).toBe(true)
  })

  it('leg 9m — gate 8, legacy byte-identity + zero run/outbox (owner red line, 2026-07-28 addendum): a `legacy_projection_only` org\'s real admin_run absence generation returns the EXACT pre-cutover response body, still fires its OWN synchronous best-effort emit (unlike leg 9\'s w4-branch directEmits===[]), and leaves all three durable run tables + the outbox at zero rows', async () => {
    const orgId = cutoverLegacyOrg
    const userId = cutoverLegacyUser
    // Allowlisted (beforeAll) + rollout row `legacy` -> resolveSegmentCalculationPosture
    // resolves `legacy_projection_only` (the SAME posture-probe branch leg 7's
    // live-punch analog exercises), not the "never allowlisted" shortcut.
    await insertRolloutRow(orgId, 'legacy')
    await insertActiveUser(userId, orgId)
    // Same rule-derived-absence date every other scheduled leg in this file uses
    // (a past Wednesday, default working day, no shift assignment => rule source +
    // UNSCHEDULED_NO_SHIFT => a generate target, exactly like leg 9's schedUser).
    const workDate = '2026-07-22'

    const adminToken = await mintToken(randomUUID(), 'attendance:read,attendance:write,attendance:admin')

    // The caller's (index.cjs runAutoAbsenceForOrgDate) OWN synchronous
    // best-effort emit — subscribed on the real, process-wide event bus, the
    // exact singleton leg 9 uses to prove the W4 branch's emit stays silent.
    const directEmits: Array<{ type: string; payload: unknown }> = []
    const absenceSubId = eventBus.subscribe('attendance.absence.generated', (payload) => {
      directEmits.push({ type: 'attendance.absence.generated', payload })
    })
    const reviewSubId = eventBus.subscribe('attendance.work_date.review_required', (payload) => {
      directEmits.push({ type: 'attendance.work_date.review_required', payload })
    })

    const res = await autoAbsenceRun(adminToken, { orgId, workDate })
    eventBus.unsubscribe(absenceSubId)
    eventBus.unsubscribe(reviewSubId)

    // Byte-identical response: the exact pre-cutover shape (no run/generation
    // identity leaks into a legacy caller's response) — a full-body `toEqual`,
    // never a subset `toMatchObject`.
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: { skipped: false, total: 1, targetUsers: 1, generated: 1, reviewRequired: [] },
    })
    expect(await recordCount(userId)).toBe(1)

    // Gate 8's sharp limb: legacy keeps its EXISTING synchronous emit — the
    // owner's "run-level events only via dispatcher" red line applies ONLY to
    // shadow/eligible/authoritative (leg 9's w4-branch assertion), never to
    // legacy_projection_only.
    expect(directEmits).toEqual([
      { type: 'attendance.absence.generated', payload: { orgId, workDate, total: 1 } },
    ])

    // Zero rows across ALL THREE durable run tables + the outbox + the W4C-0
    // operation table (legacy never mints an operation either).
    expect(await scheduledRunRows(orgId)).toEqual([])
    expect((await operationRows(orgId, 'scheduled')).length).toBe(0)
    expect(await outboxRows(orgId)).toEqual([])
    for (const table of ['attendance_scheduled_run_targets', 'attendance_scheduled_run_target_outcomes'] as const) {
      const n = (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId])).rows[0].n
      expect(n, `${table} must stay empty under legacy posture`).toBe(0)
    }
  })

  it('leg 9m-dedup — the process-local key remains a zero-DML legacy-only short circuit', async () => {
    const orgId = randomUUID()
    await insertRolloutRow(orgId, 'legacy')
    const { adapters, absenceCallCount } = throwingScheduledAdapters()
    const boundary = buildDirectScheduledBoundary(adapters)

    const outcome = await boundary.executeScheduledRun({
      orgId,
      workDate: '2026-07-22',
      timezone: 'UTC',
      targetUserIds: [randomUUID()],
      reviewTargets: [],
      initiator: 'cron',
      adminActorId: null,
      legacyDedupHit: true,
    })

    expect(outcome).toEqual({ kind: 'legacy_dedup' })
    expect(absenceCallCount()).toBe(0)
    expect(await scheduledRunRows(orgId)).toEqual([])
  })

  it('leg 9m2 — P2-1 fix (#4612 verdict second gate round): a `legacy_projection_only` org with TWO W2-ambiguous members exercises the ONLY shape leg 9m\'s empty `reviewRequired: []` cannot see — the deleted `ORDER BY uo.user_id ASC` (verdict P2-1) previously changed exactly this array\'s element order versus pre-amendment `main`; asserted as an exact SET (order is, and always was, unspecified absent an explicit sort — the frozen membership-query row order was never a real contract), never a literal sequence a real row-order flake could later break', async () => {
    const orgId = randomUUID()
    const genUser = randomUUID()
    const ambUserA = randomUUID()
    const ambUserB = randomUUID()
    const ambShiftA1 = randomUUID()
    const ambShiftA2 = randomUUID()
    const ambShiftB1 = randomUUID()
    const ambShiftB2 = randomUUID()
    try {
      await insertRolloutRow(orgId, 'legacy')
      await insertActiveUser(genUser, orgId)
      await insertActiveUser(ambUserA, orgId)
      await insertActiveUser(ambUserB, orgId)
      // Same "natural OVERLAPPING_SHIFT_WINDOWS shape, not a synthetic resolver stub" fixture
      // leg 9's schedAmbUser already uses (this file's own `insertShift`/`insertAssignment`
      // helpers) — TWO independently-ambiguous members, so `reviewRequired` has 2 elements and
      // their RELATIVE order is an observable fact, not a length-1 blind spot.
      await insertShift(ambShiftA1, orgId, 'w4c2-e5-leg9m2-a1', '09:00', '18:00')
      await insertShift(ambShiftA2, orgId, 'w4c2-e5-leg9m2-a2', '08:00', '17:00')
      await insertAssignment(orgId, ambUserA, ambShiftA1, 0)
      await insertAssignment(orgId, ambUserA, ambShiftA2, 1)
      await insertShift(ambShiftB1, orgId, 'w4c2-e5-leg9m2-b1', '09:00', '18:00')
      await insertShift(ambShiftB2, orgId, 'w4c2-e5-leg9m2-b2', '08:00', '17:00')
      await insertAssignment(orgId, ambUserB, ambShiftB1, 0)
      await insertAssignment(orgId, ambUserB, ambShiftB2, 1)
      const workDate = '2026-07-22'

      const adminToken = await mintToken(randomUUID(), 'attendance:read,attendance:write,attendance:admin')
      const res = await autoAbsenceRun(adminToken, { orgId, workDate })

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.data).toMatchObject({ skipped: false, total: 1, targetUsers: 1, generated: 1 })
      expect(res.body.data.reviewRequired).toHaveLength(2)
      // Exact SET (not sequence): both ambiguous members present, each with the correct
      // reason code, regardless of which physical row order Postgres happened to return.
      expect(new Set(res.body.data.reviewRequired.map((r: { userId: string }) => r.userId))).toEqual(
        new Set([ambUserA, ambUserB]),
      )
      for (const entry of res.body.data.reviewRequired) {
        expect(entry.reasonCode).toBe('WORK_DATE_ATTRIBUTION_AMBIGUOUS')
        expect([ambUserA, ambUserB]).toContain(entry.userId)
      }
      expect(await recordCount(genUser)).toBe(1)
      expect(await recordCount(ambUserA)).toBe(0)
      expect(await recordCount(ambUserB)).toBe(0)

      // Same zero-durable-rows invariant leg 9m already asserts — this leg's ONLY new claim is
      // the reviewRequired SET/length, not a re-test of gate 8's durable-table isolation.
      expect(await scheduledRunRows(orgId)).toEqual([])
      expect(await outboxRows(orgId)).toEqual([])
    } finally {
      for (const userId of [genUser, ambUserA, ambUserB]) {
        await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [userId]).catch(() => undefined)
        await pool?.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined)
      }
      await pool?.query('DELETE FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId]).catch(() => undefined)
    }
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
        reviewTargets: [],
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
        reviewTargets: [],
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
      reviewTargets: [],
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
        reviewTargets: [],
        initiator: 'cron',
        adminActorId: adminWitnessRealAdmin,
      }),
    ).rejects.toMatchObject({ code: 'W4C2_SCHEDULED_WITNESS_INITIATOR_MISMATCH' })

    expect(absenceCallCount()).toBe(0)
    expect((await operationRows(untouchedOrg, 'scheduled')).length).toBe(0)
  })

  it('P1-4 leg D — W4C2_SCHEDULED_ADMIN_WITNESS_REQUIRED (#4612 gate2 M7 finding: deleting this guard left e5 17/17 green): admin_run with a null adminActorId is rejected at MINT, before any per-user transaction opens (zero absence-adapter calls; zero new operation rows)', async () => {
    // Real production caller unreachability (why this guard's own producer
    // never fires it, per the gate's P3-1 disposition): the only production
    // `admin_run` caller is index.cjs's `POST /api/attendance/auto-absence/run`
    // route, which passes `getUserId(req)` as `adminActorId` — and
    // `withPermission('attendance:admin', ...)` (-> `withAnyPermission`) 401s
    // BEFORE the handler runs at all when there is no authenticated user, so
    // the route can never reach this boundary call with a null/empty
    // adminActorId. This leg proves the BOUNDARY's own guard is load-bearing
    // in isolation (defense in depth), independent of route reachability —
    // exactly the leg 5a-5d/A-C direct-witness-construction style above.
    const { adapters, absenceCallCount } = throwingScheduledAdapters()
    const boundary = buildDirectScheduledBoundary(adapters)
    const opsBefore = (await operationRows(adminWitnessOrg, 'scheduled')).length

    await expect(
      boundary.executeScheduledRun({
        orgId: adminWitnessOrg,
        workDate: '2026-07-13',
        timezone: 'UTC',
        targetUserIds: [adminWitnessTargetUser],
        reviewTargets: [],
        initiator: 'admin_run',
        adminActorId: null,
      }),
    ).rejects.toMatchObject({ code: 'W4C2_SCHEDULED_ADMIN_WITNESS_REQUIRED' })

    expect(absenceCallCount()).toBe(0)
    expect((await operationRows(adminWitnessOrg, 'scheduled')).length).toBe(opsBefore)
    expect(await recordCount(adminWitnessTargetUser)).toBe(0)
  })
})
