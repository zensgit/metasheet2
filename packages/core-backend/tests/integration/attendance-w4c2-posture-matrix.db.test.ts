/**
 * W4C-2 (#4556 lock §12.3) — three-posture matrix for legacy-only business time,
 * V2 attribution FREEZE, and the env-gated outbox drain worker (real DB, real
 * MetaSheetServer + plugin activate, route-level).
 *
 * This server starts WITH the exact-org env allowlist
 * (ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED) covering the suite's shadow/
 * eligible/freeze orgs, so persisted `shadow`/`eligible` rollout rows become
 * EFFECTIVE (w4c0-identity posture doctrine: state row AND exact-org env entry).
 * `legacy_projection_only` remains the posture for every other org.
 *
 * Lock §12.3 matrix ("removing either side fails independently" mapping):
 *  - leg 1 (legacy): an offset-less business time under `legacy_projection_only`
 *    keeps the exact legacy response with ZERO operation/calculation/outbox rows
 *    — a mutation that rejects legacy-only time everywhere fails THIS leg alone;
 *  - leg 2 (shadow): the same time under effective `shadow` still executes the
 *    legacy projection (event + record written, legacy response bytes returned —
 *    a mutation that rejects the shadow legacy write fails here independently)
 *    AND appends EXACTLY ONE zero-segment `legacy_time_ingress_not_authoritative`
 *    review carrying raw + legacy-parser provenance (a mutation that omits the
 *    review, or treats the legacy-resolved instant as W4 evidence and takes the
 *    normal calculation path, fails the exact-shape assertions here);
 *  - leg 3 (eligible): the same time under effective `eligible` is rejected
 *    BEFORE any event/request/result/effect DML (the preflight claim rolls back
 *    with the transaction), with a strict-time POSITIVE CONTROL on the same org
 *    proving the rejection leg is not vacuous.
 *
 * V2 freeze (lock 5.1/5.2 "request creation or a previous calculation freezes
 * the absolute/attribution windows; changing tail/overtime/assignment later
 * must not move them"): a resolved_v2 shadow calculation pins the candidate
 * windows as literals; a subsequent SHIFT DEFINITION change (1) moves the NEXT
 * calculation's windows (positive control that config changes do reach fresh
 * resolutions) while (2) the earlier stored snapshot re-reads byte-identical,
 * and (3) a direct UPDATE of the stored snapshot is trigger-denied
 * (W4C0_IMMUTABLE) — the freeze is absolute at the storage layer too.
 *
 * Outbox drain worker (lock 7.1a delivery side): with the env gate present the
 * plugin registered the drain job at activate; `runOnce` here is the EXACT
 * closure the shared scheduler ticks (module export, not a copy), and one pass
 * delivers every pending row this suite created. The paired no-env leg lives in
 * attendance-w4c2-live-scheduled-boundary.db.test.ts (gated=false), so
 * neutering the env gate fails that leg while this one stays green — exclusive.
 *
 * Shared-DB discipline: fixture ids are file-namespaced random UUIDs; rollout
 * rows and W4 calculation/operation/outbox rows are append-only by design and
 * keyed by throwaway org/user UUIDs (records with calculations cannot be
 * deleted — FK RESTRICT + append-only trigger — and are left in place).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'module'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { createHash, randomUUID } from 'crypto'
import { Pool } from 'pg'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const requireCjs = createRequire(import.meta.url)

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

describeDb('W4C-2 posture matrix + V2 freeze + env-gated outbox drain (real DB, route-level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool
  let priorAllowlistEnv: string | undefined

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  async function mintToken(userId: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write')}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }
  const punch = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/punch`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })

  // File-namespaced fixtures (shared DB).
  const legacyOrg = randomUUID()
  const shadowOrg = randomUUID()
  const eligibleOrg = randomUUID()
  const freezeOrg = randomUUID()
  const legacyUser = randomUUID()
  const shadowUser = randomUUID()
  const eligibleControlUser = randomUUID()
  const eligibleRejectUser = randomUUID()
  const freezeUser = randomUUID()
  const freezeShiftId = randomUUID()

  // A business time only the legacy parser accepts (offset-less => process-local).
  const OFFSETLESS = '2026-07-20 09:30:00'

  async function insertActiveUser(userId: string, orgId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-2 matrix fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@w4c2-matrix.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }

  async function insertRolloutRow(orgId: string, state: 'legacy' | 'shadow'): Promise<void> {
    // 'legacy' and 'shadow' are the guard's legal INITIAL states.
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, $2, 'w4c2-matrix', 'TEST_FIXTURE', 'w4c2-matrix-actor', 1, NULL)`,
      [orgId, state],
    )
  }

  async function walkRolloutToEligible(orgId: string): Promise<void> {
    await insertRolloutRow(orgId, 'shadow')
    await pool.query(
      `UPDATE attendance_calculation_rollout_state SET state = 'eligible', prior_state = 'shadow', version = 2 WHERE org_id = $1`,
      [orgId],
    )
  }

  const eventCount = async (userId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_events WHERE user_id = $1', [userId])).rows[0].n)
  const recordCount = async (userId: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM attendance_records WHERE user_id = $1', [userId])).rows[0].n)
  const operationRows = async (orgId: string) =>
    (await pool.query(
      `SELECT operation_id::text AS operation_id, state, accepted_write_posture,
              resolved_record_id::text AS resolved_record_id,
              resolved_calculation_id::text AS resolved_calculation_id, response_snapshot
       FROM attendance_result_operations WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    )).rows
  const calculationRowsForUser = async (userId: string) =>
    (await pool.query(
      `SELECT c.id::text AS id, c.org_id, c.version, c.calculation_kind, c.mode, c.entrypoint,
              c.operation_id::text AS operation_id, c.outcome, c.outcome_reason_code,
              c.projection_effect, c.expected_segment_count, c.context_snapshot,
              c.attribution_snapshot, c.evidence_snapshot, c.segment_snapshot, c.input_provenance,
              c.projected_status, c.projected_first_in_at, c.projected_last_out_at,
              c.projected_work_minutes, c.projected_late_minutes, c.projected_early_leave_minutes,
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
      `SELECT id::text AS id, entrypoint, operation_id::text AS operation_id, event_kind,
              delivery_state, delivered_at, attempts
       FROM attendance_result_event_outbox WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    )).rows

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('W4C-2 posture matrix integration needs a loopback port + DATABASE_URL')

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    // Exact-org allowlist BEFORE activate: makes the persisted shadow/eligible
    // rows effective AND arms the plugin's outbox drain worker registration.
    priorAllowlistEnv = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = `${shadowOrg},${eligibleOrg},${freezeOrg}`

    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })

    await insertRolloutRow(legacyOrg, 'legacy')
    await insertRolloutRow(shadowOrg, 'shadow')
    await walkRolloutToEligible(eligibleOrg)
    await insertRolloutRow(freezeOrg, 'shadow')
    for (const [userId, orgId] of [
      [legacyUser, legacyOrg],
      [shadowUser, shadowOrg],
      [eligibleControlUser, eligibleOrg],
      [eligibleRejectUser, eligibleOrg],
      [freezeUser, freezeOrg],
    ] as const) {
      await insertActiveUser(userId, orgId)
    }
    // Freeze fixture: one published shift assignment so the W2 resolver mints a
    // real winner (Asia/Shanghai 09:00-18:00 => 01:00Z-10:00Z absolute window).
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, work_start_time, work_end_time, timezone)
       VALUES ($1, $2, 'w4c2-freeze-shift', '09:00', '18:00', 'Asia/Shanghai')`,
      [freezeShiftId, freezeOrg],
    )
    await pool.query(
      `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
       VALUES ($1, $2, $3, $4, 0, '2026-07-01', NULL, true, 'published', 'regular')`,
      [randomUUID(), freezeOrg, freezeUser, freezeShiftId],
    )
  }, 120000)

  afterAll(async () => {
    // W4 calculation/segment/operation/outbox/rollout rows are append-only by
    // design (UPDATE/DELETE trigger-denied) and records carrying calculations
    // are FK-RESTRICTED — all are keyed by this file's throwaway UUIDs, so they
    // are left in place. Only plain user fixtures are removed.
    for (const userId of [legacyUser, shadowUser, eligibleControlUser, eligibleRejectUser, freezeUser]) {
      await pool?.query('DELETE FROM user_orgs WHERE user_id = $1', [userId]).catch(() => undefined)
      await pool?.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined)
    }
    if (priorAllowlistEnv === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlistEnv
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
  }, 60000)

  it('matrix leg 1 — legacy posture: offset-less business time keeps the exact legacy response with ZERO W4 rows', async () => {
    const token = await mintToken(legacyUser)
    const res = await punch(token, { eventType: 'check_in', occurredAt: OFFSETLESS, orgId: legacyOrg })
    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
    expect(Object.keys(res.body.data).sort()).toEqual(['event', 'record', 'workDateResolution'])
    expect(res.body.data.event.user_id).toBe(legacyUser)
    expect(await eventCount(legacyUser)).toBe(1)
    expect(await recordCount(legacyUser)).toBe(1)
    expect((await operationRows(legacyOrg)).length).toBe(0)
    expect((await calculationRowsForUser(legacyUser)).length).toBe(0)
    expect((await outboxRows(legacyOrg)).length).toBe(0)
  })

  it('matrix leg 2 — effective shadow: legacy projection preserved PLUS exactly one zero-segment legacy_time_ingress review (raw + parser provenance), sealed + outboxed', async () => {
    const token = await mintToken(shadowUser)
    const operationId = randomUUID()
    const res = await punch(token, { eventType: 'check_in', occurredAt: OFFSETLESS, orgId: shadowOrg, operationId })

    // Shadow preserves the legacy response/projection ("rejecting the shadow
    // legacy write fails independently" — this half fails alone if shadow
    // starts rejecting legacy-only time).
    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
    expect(Object.keys(res.body.data).sort()).toEqual(['event', 'record', 'workDateResolution'])
    expect(await eventCount(shadowUser)).toBe(1)
    expect(await recordCount(shadowUser)).toBe(1)

    // Exactly ONE review calculation, exact closed shape ("omitting the shadow
    // review fails independently"; "treating the legacy-resolved instant as W4
    // evidence" would flip outcome/reason/evidence below).
    const calcs = await calculationRowsForUser(shadowUser)
    expect(calcs.length).toBe(1)
    const calc = calcs[0]
    expect(calc).toMatchObject({
      org_id: shadowOrg,
      version: 1,
      calculation_kind: 'calculation',
      mode: 'shadow',
      entrypoint: 'live',
      operation_id: operationId,
      outcome: 'review_required',
      outcome_reason_code: 'legacy_time_ingress_not_authoritative',
      projection_effect: 'none',
      expected_segment_count: 0,
      context_snapshot: null,
      projected_status: null,
      projected_first_in_at: null,
      projected_last_out_at: null,
      projected_work_minutes: null,
      projected_late_minutes: null,
      projected_early_leave_minutes: null,
    })
    expect(calc.segment_snapshot).toEqual([])
    expect(await segmentCountForCalculation(calc.id)).toBe(0)
    // The legacy-only value is NOT admissible W4 evidence: the closed evidence
    // snapshot stays EMPTY, and the frozen raw value + legacy-parser provenance
    // + exact legacy-resolved instant live in input_provenance.
    expect(calc.evidence_snapshot).toEqual([])
    const ingress = calc.input_provenance?.legacyTimeIngress
    expect(ingress).toBeTruthy()
    expect(Object.keys(ingress).sort()).toEqual(['parser', 'raw', 'resolvedInstant'])
    expect(ingress.raw).toBe(OFFSETLESS)
    expect(ingress.parser).toBe('legacy_parseDateInput_server_local')
    expect(typeof ingress.resolvedInstant).toBe('string')
    expect(new Date(ingress.resolvedInstant).toISOString()).toBe(ingress.resolvedInstant)
    // Attribution: unsupported (never a fabricated V2), fingerprinting the raw bytes.
    expect(calc.attribution_snapshot).toEqual({
      posture: 'unsupported',
      sourceSchemaVersion: null,
      reason: 'unresolved',
      sourceFingerprint: createHash('sha256').update(OFFSETLESS, 'utf8').digest('hex'),
    })

    // Sealed operation with the shadow write posture and the W4 result pointer.
    const ops = (await operationRows(shadowOrg)).filter((row) => row.operation_id === operationId)
    expect(ops.length).toBe(1)
    expect(ops[0]).toMatchObject({
      state: 'completed',
      accepted_write_posture: 'shadow',
      resolved_calculation_id: calc.id,
      resolved_record_id: calc.record_id,
    })
    expect(ops[0].response_snapshot).toEqual(res.body.data)

    // Durable outbox row enqueued in the same transaction (before seal), still pending.
    const outbox = await outboxRows(shadowOrg)
    expect(outbox.length).toBe(1)
    expect(outbox[0]).toMatchObject({
      entrypoint: 'live_punch',
      operation_id: operationId,
      event_kind: 'attendance.punched',
      delivery_state: 'pending',
      delivered_at: null,
    })
  })

  it('matrix leg 3 — effective eligible: offset-less business time is rejected BEFORE any event/record/result/effect DML (positive control: strict time writes on the same org)', async () => {
    // POSITIVE CONTROL first: a strict instant on the SAME eligible org executes
    // the shadow path (eligible normalizes to the shadow write posture).
    const controlToken = await mintToken(eligibleControlUser)
    const controlOperationId = randomUUID()
    const control = await punch(controlToken, {
      eventType: 'check_in',
      occurredAt: '2026-07-20T01:00:00.000Z',
      orgId: eligibleOrg,
      operationId: controlOperationId,
    })
    expect(control.status).toBe(200)
    expect(await eventCount(eligibleControlUser)).toBe(1)
    const controlCalcs = await calculationRowsForUser(eligibleControlUser)
    expect(controlCalcs.length).toBe(1)
    expect(controlCalcs[0]).toMatchObject({
      mode: 'shadow',
      entrypoint: 'live',
      operation_id: controlOperationId,
      outcome: 'review_required',
      // No shift assignment on this org: the in-transaction W2 freeze resolves
      // to `unsupported` and the calculator's closed mapping is
      // missing_frozen_context — never a completed calculation from a guess.
      outcome_reason_code: 'missing_frozen_context',
      projection_effect: 'none',
    })

    // Rejection leg: identical shape but a legacy-only business time.
    const token = await mintToken(eligibleRejectUser)
    const operationId = randomUUID()
    const res = await punch(token, { eventType: 'check_in', occurredAt: OFFSETLESS, orgId: eligibleOrg, operationId })
    expect(res.status).toBe(422)
    expect(res.body?.error?.code).toBe('W4_ATTRIBUTION_UNSUPPORTED')
    // Values-free: the closed code is the whole message; the raw value is never echoed.
    expect(res.body?.error?.message).toBe('W4_ATTRIBUTION_UNSUPPORTED')
    expect(res.raw.includes(OFFSETLESS)).toBe(false)

    // BEFORE any DML: no event, no record, no calculation; the preflight claim
    // itself rolled back (no operation row), and no outbox row was added.
    expect(await eventCount(eligibleRejectUser)).toBe(0)
    expect(await recordCount(eligibleRejectUser)).toBe(0)
    expect((await calculationRowsForUser(eligibleRejectUser)).length).toBe(0)
    const ops = await operationRows(eligibleOrg)
    expect(ops.length).toBe(1)
    expect(ops[0].operation_id).toBe(controlOperationId)
    expect((await outboxRows(eligibleOrg)).length).toBe(1)
  })

  it('V2 freeze — a shift change after a calculation moves the NEXT window but never the frozen one; the stored snapshot is UPDATE-denied', async () => {
    const token = await mintToken(freezeUser)

    // Calculation 1: strict check_in inside the assigned shift => resolved_v2
    // attribution with the candidate windows frozen as literals.
    const opA = randomUUID()
    const first = await punch(token, {
      eventType: 'check_in',
      occurredAt: '2026-07-20T01:05:00.000Z',
      orgId: freezeOrg,
      operationId: opA,
    })
    expect(first.status).toBe(200)
    let calcs = await calculationRowsForUser(freezeUser)
    expect(calcs.length).toBe(1)
    const calc1 = calcs[0]
    expect(calc1.outcome).toBe('completed')
    expect(calc1.outcome_reason_code).toBe('calculated')
    expect(calc1.mode).toBe('shadow')
    expect(calc1.projection_effect).toBe('none')
    const attribution1 = calc1.attribution_snapshot
    expect(attribution1.posture).toBe('resolved_v2')
    expect(attribution1.value.shiftId).toBe(freezeShiftId)
    expect(attribution1.value.absoluteWindow).toEqual({
      startAt: '2026-07-20T01:00:00.000Z',
      endAt: '2026-07-20T10:00:00.000Z',
    })
    expect(attribution1.value.attributionWindow.startAt).toBe('2026-07-20T01:00:00.000Z')
    // Attribution end = absolute end + the frozen tail (self-consistent check;
    // the tail source is org policy and not pinned by this suite).
    const tailMs = attribution1.value.attributionTailMinutes * 60_000
    expect(new Date(attribution1.value.attributionWindow.endAt).getTime()).toBe(
      new Date('2026-07-20T10:00:00.000Z').getTime() + tailMs,
    )
    const frozenSnapshotBytes = JSON.stringify(attribution1)

    // Assignment/shift change AFTER the calculation: end moves 18:00 -> 19:00.
    await pool.query(`UPDATE attendance_shifts SET work_end_time = '19:00' WHERE id = $1`, [freezeShiftId])

    // Calculation 2 (fresh resolution): the NEW window end — the positive
    // control that shift changes DO reach fresh resolutions, so the identical
    // window on calc 1 below is a real freeze, not a constant.
    const opB = randomUUID()
    const second = await punch(token, {
      eventType: 'check_out',
      occurredAt: '2026-07-20T10:10:00.000Z',
      orgId: freezeOrg,
      operationId: opB,
    })
    expect(second.status).toBe(200)
    calcs = await calculationRowsForUser(freezeUser)
    expect(calcs.length).toBe(2)
    const calc2 = calcs[1]
    expect(calc2.version).toBe(2)
    expect(calc2.attribution_snapshot.posture).toBe('resolved_v2')
    expect(calc2.attribution_snapshot.value.absoluteWindow).toEqual({
      startAt: '2026-07-20T01:00:00.000Z',
      endAt: '2026-07-20T11:00:00.000Z',
    })

    // The frozen windows did NOT move: byte-identical re-read.
    const reread = await calculationRowsForUser(freezeUser)
    expect(JSON.stringify(reread[0].attribution_snapshot)).toBe(frozenSnapshotBytes)

    // Storage-level freeze: the stored snapshot cannot be rewritten at all.
    await expect(
      pool.query(
        `UPDATE attendance_record_calculations SET attribution_snapshot = '{}'::jsonb WHERE id = $1::uuid`,
        [calc1.id],
      ),
    ).rejects.toThrow(/W4C0_IMMUTABLE/)
  })

  it('env-gated outbox drain worker: registered under this allowlist env, and ONE pass of the production closure delivers every pending row', async () => {
    const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW4OutboxDrainForTests?: {
        getState(): { gated: boolean }
        runOnce(): Promise<{ claimed: number; delivered: number; failed: number }>
      }
    }
    const probe = plugin.__attendanceW4OutboxDrainForTests
    expect(probe).toBeTruthy()
    // Env present at activate => the worker exists (the paired no-env leg in the
    // boundary wiring suite asserts gated=false — neutering the gate cannot
    // satisfy both).
    expect(probe!.getState()).toEqual({ gated: true })

    // Pending rows produced by the legs above: shadow(1) + eligible control(1)
    // + freeze(2). The org-scoped count is exact; the drain pass itself is
    // global by design, so its counts are anchored to the global pending total
    // (== 4 on a fresh CI database; a dirty local re-run may carry stale rows).
    const globalPending = async () =>
      Number((await pool.query(
        `SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE delivery_state = 'pending'`,
      )).rows[0].n)
    const pendingBefore = Number(
      (await pool.query(
        `SELECT count(*)::int AS n FROM attendance_result_event_outbox
         WHERE delivery_state = 'pending' AND org_id = ANY($1)`,
        [[shadowOrg, eligibleOrg, freezeOrg]],
      )).rows[0].n,
    )
    expect(pendingBefore).toBe(4)
    const globalBefore = await globalPending()
    expect(globalBefore).toBeGreaterThanOrEqual(4)

    const drained = await probe!.runOnce()
    expect(drained).toEqual({ claimed: globalBefore, delivered: globalBefore, failed: 0 })
    for (const orgId of [shadowOrg, eligibleOrg, freezeOrg]) {
      for (const row of await outboxRows(orgId)) {
        expect(row.delivery_state).toBe('delivered')
        expect(row.delivered_at).not.toBeNull()
      }
    }
    // Second pass: nothing left to claim.
    const again = await probe!.runOnce()
    expect(again).toEqual({ claimed: 0, delivered: 0, failed: 0 })
    const pendingAfter = Number(
      (await pool.query(
        `SELECT count(*)::int AS n FROM attendance_result_event_outbox
         WHERE delivery_state = 'pending' AND org_id = ANY($1)`,
        [[shadowOrg, eligibleOrg, freezeOrg]],
      )).rows[0].n,
    )
    expect(pendingAfter).toBe(0)
  })
})
