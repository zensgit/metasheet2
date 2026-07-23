/**
 * W5-0 (Wave 5 explainability design-lock 2026-07-22, RATIFIED §3/§4/§9): real-Postgres coverage of
 * `GET /api/attendance-admin/decision-trace` (admin host) and `GET /api/attendance/decision-trace`
 * (self host). The mock-level unit test
 * (`tests/unit/attendance-decision-trace-w5-0.test.ts`) already covers response-shape/discriminated-
 * union/branch coverage exhaustively; THIS file proves the things only real Postgres + real
 * authorization wiring can prove:
 *   G1/G7 — dual-host authorization matrix: admin/self × own-org/foreign-org × spoofed
 *           userId/orgId, self multi-org four-leg (0/1/>1-no-orgId/>1-with-orgId), platform-admin
 *           override, and the two-user/same-org SUBJECT-CONSTRAINED negative matrix (one leg per
 *           category) with a subject-predicate-removal mutation.
 *   G2      — response key-set + no-raw-id + org-scoping negative controls against a REAL cross-org
 *             fixture (a mock can assert "the SQL text mentions org_id=$1" but only real Postgres
 *             proves the actual result set never crosses the boundary).
 *   G3      — the READ ONLY seam is REUSED (not re-derived) — `runAttendanceSetupReadinessReadOnly`
 *             already has the three-case Postgres write-rejection proof
 *             (`attendance-setup-readiness-w4-0.db.test.ts` §9 W4-0-G2); this file adds ONE
 *             confirming assertion that `runAttendanceDecisionTraceReadOnly` is that exact function.
 *   G4      — ⑤ unknown-source-type real fixture: a raw string is INSERTed DIRECTLY into
 *             `attendance_leave_balances.source_type` (NEVER via `deductLeaveBalance`, which writes
 *             the EVENTS table's `source_type` column, not the lot's — that fixture shape would let
 *             the lot-side assertion pass vacuously, per the design lock's own G4 warning).
 *   G5      — `not_in_effect` (engine OFF) vs `undeterminable` (engine ON, no snapshot) are two
 *             DIFFERENT postures against the real `system_configs` row.
 *   G6      — a request that was overtime-segmented BEFORE this test flips the live
 *             `attendance_overtime_rules` row stays BYTE-STABLE afterward (snapshot exclusivity).
 *
 * Shared-DB fixture discipline: every fixture id is prefixed `w50_<run>_` (W4-0 precedent,
 * `plugin-tests.yml` runs many `.db.test.ts` files against ONE shared Postgres;
 * `vitest.integration.config.ts` pins `fileParallelism: false`).
 *
 * Fixture shape reference (per-table): `attendance_records(org_id, user_id, work_date, status,
 * is_workday, work_minutes, late_minutes, early_leave_minutes, meta)`; `attendance_requests(org_id,
 * user_id, work_date, request_type, status, approval_instance_id, metadata, resolved_at)`;
 * `attendance_leave_balances(org_id, user_id, leave_type_code, amount_minutes, remaining_minutes,
 * source_type, source_key, status, granted_at, expires_at, overtime_source)`;
 * `attendance_leave_balance_events(org_id, user_id, balance_id, event_type, delta_minutes,
 * source_type, source_id)`; `approval_instances(id, status, version, requester_snapshot, metadata,
 * created_at)`; `approval_assignments(instance_id, assignment_type, assignee_id, source_step,
 * metadata, is_active)`; `approval_records(instance_id, action, actor_id, to_status, occurred_at)`;
 * `attendance_overtime_rules(org_id, name, is_active)`; `attendance_payroll_cycles(org_id,
 * start_date, end_date, status)`; `attendance_payroll_cycle_settlements(org_id, cycle_id, user_id,
 * source, closed_at, period_start_date, period_end_date)`.
 */
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'
import {
  snapshotAttendanceSettingsRow,
  restoreAttendanceSettingsRow,
  type AttendanceSettingsRowSnapshot,
} from '../utils/attendance-settings-row'

vi.mock('../../src/rbac/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/rbac')>()
  return {
    ...actual,
    rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }
})
vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return { ...actual, isAdmin: vi.fn(async (userId: string) => userId.endsWith('_platform_admin')) }
})

// Real Postgres, spy-WRAPPED (not replaced) — same technique as the W4-0 precedent: `.mock.calls`
// gives visibility for the "zero trace SQL before rejection" proof (G1/G7) while every call still
// hits real Postgres.
vi.mock('../../src/db/pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/pg')>()
  return { ...actual, query: vi.fn(actual.query), transaction: vi.fn(actual.transaction) }
})

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const { attendanceAdminRouter } = await import('../../src/routes/attendance-admin')
const { query: mockedQuery, transaction: mockedTransaction } = await import('../../src/db/pg')
const { runAttendanceDecisionTraceReadOnly } = await import('../../src/services/AttendanceDecisionTrace')
const { runAttendanceSetupReadinessReadOnly } = await import('../../src/services/AttendanceSetupReadinessAggregate')
const queryMock = mockedQuery as unknown as ReturnType<typeof vi.fn>
const transactionMock = mockedTransaction as unknown as ReturnType<typeof vi.fn>

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const PFX = `w50_${RUN}`
const SETTINGS_KEY = 'attendance.settings'

function makeApp(user: Record<string, unknown> | null) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = user ?? undefined
    next()
  })
  app.use(attendanceAdminRouter())
  return app
}

it('sentinel: DATABASE_URL is set (real-DB lane must not silently skip)', () => {
  expect(dbUrl).toBeTruthy()
})

describeIfDatabase('W5-0 GET decision-trace (admin + self hosts, real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const pinned = usePinnedServer()
  let settingsRowSnapshot: AttendanceSettingsRowSnapshot | undefined

  async function seedUser(userId: string, isActive = true): Promise<void> {
    await pool.query(
      `INSERT INTO users (id, password_hash, is_active) VALUES ($1, 'x', $2)
       ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
      [userId, isActive],
    )
  }
  async function seedMembership(orgId: string, userId: string, isActive = true, userIsActive = true): Promise<void> {
    await seedUser(userId, userIsActive)
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = EXCLUDED.is_active`,
      [userId, orgId, isActive],
    )
  }
  async function seedRecord(
    orgId: string,
    userId: string,
    workDate: string,
    fields: Partial<{
      status: string
      isWorkday: boolean
      workMinutes: number
      lateMinutes: number
      earlyLeaveMinutes: number
      meta: Record<string, unknown>
      firstInAt: string | null
      lastOutAt: string | null
    }> = {},
  ): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO attendance_records
         (org_id, user_id, work_date, status, is_workday, work_minutes, late_minutes, early_leave_minutes, meta, first_in_at, last_out_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (user_id, work_date, org_id) DO UPDATE SET
         status = EXCLUDED.status, is_workday = EXCLUDED.is_workday, work_minutes = EXCLUDED.work_minutes,
         late_minutes = EXCLUDED.late_minutes, early_leave_minutes = EXCLUDED.early_leave_minutes,
         meta = EXCLUDED.meta, first_in_at = EXCLUDED.first_in_at, last_out_at = EXCLUDED.last_out_at
       RETURNING id`,
      [
        orgId, userId, workDate,
        fields.status ?? 'normal', fields.isWorkday ?? true, fields.workMinutes ?? 480,
        fields.lateMinutes ?? 0, fields.earlyLeaveMinutes ?? 0, JSON.stringify(fields.meta ?? {}),
        fields.firstInAt ?? null, fields.lastOutAt ?? null,
      ],
    )
    return r.rows[0].id
  }
  async function seedOvertimeRequest(
    orgId: string,
    userId: string,
    workDate: string,
    metadata: Record<string, unknown>,
    resolvedAt: string | null = null,
  ): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO attendance_requests (org_id, user_id, work_date, request_type, status, metadata, resolved_at)
       VALUES ($1,$2,$3,'overtime','approved',$4::jsonb,$5) RETURNING id`,
      [orgId, userId, workDate, JSON.stringify(metadata), resolvedAt],
    )
    return r.rows[0].id
  }
  async function seedApprovalInstanceWithAssignment(
    orgId: string,
    requesterUserId: string,
    assigneeUserId: string,
    resolvedFromKind: string,
  ): Promise<string> {
    const instanceId = `${PFX}_inst_${randomUUID()}`
    await pool.query(
      `INSERT INTO approval_instances (id, status, version, requester_snapshot, metadata)
       VALUES ($1, 'pending', 0, '{}'::jsonb, '{"approvalFlow":{"steps":[]}}'::jsonb)`,
      [instanceId],
    )
    await pool.query(
      `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, source_step, metadata, is_active)
       VALUES ($1, 'user', $2, 0, $3::jsonb, true)`,
      [instanceId, assigneeUserId, JSON.stringify({ resolvedFrom: { kind: resolvedFromKind } })],
    )
    await pool.query(
      `INSERT INTO approval_records (instance_id, action, actor_id, to_status, occurred_at)
       VALUES ($1, 'approve', $2, 'pending', now())`,
      [instanceId, assigneeUserId],
    )
    // The reverse-link that authorizes ⑥: a request row owned by requesterUserId pointing at this instance.
    await pool.query(
      `INSERT INTO attendance_requests (org_id, user_id, work_date, request_type, status, approval_instance_id)
       VALUES ($1,$2,CURRENT_DATE,'time_correction','pending',$3)`,
      [orgId, requesterUserId, instanceId],
    )
    return instanceId
  }
  async function seedLot(
    orgId: string,
    userId: string,
    sourceType: string,
    tag: string,
    overtimeSource: string | null = null,
  ): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO attendance_leave_balances (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at, overtime_source)
       VALUES ($1,$2,'comp_time',480,480,$3,$4,'active','2026-07-01',$5) RETURNING id`,
      [orgId, userId, sourceType, `${PFX}:${tag}:${randomUUID()}`, overtimeSource],
    )
    return r.rows[0].id
  }
  async function writeSettingsRow(value: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO system_configs (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [SETTINGS_KEY, JSON.stringify(value)],
    )
  }

  beforeAll(async () => {
    settingsRowSnapshot = await snapshotAttendanceSettingsRow(pool)
  }, 30000)

  afterAll(async () => {
    await restoreAttendanceSettingsRow(pool, settingsRowSnapshot)
    await pool.query(`DELETE FROM attendance_leave_balance_events WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_leave_balances WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_payroll_cycle_settlements WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_payroll_cycles WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_record_result_edits WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_requests WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_records WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM attendance_overtime_rules WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM approval_assignments WHERE instance_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM approval_records WHERE instance_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM approval_instances WHERE id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM user_orgs WHERE org_id LIKE $1`, [`${PFX}%`])
    await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PFX}%`])
    await pool.end()
  })

  afterEach(async () => {
    await restoreAttendanceSettingsRow(pool, settingsRowSnapshot)
    queryMock.mockClear()
    transactionMock.mockClear()
  })

  // -----------------------------------------------------------------------------------------------
  // G1/G7 dual-host authorization matrix
  // -----------------------------------------------------------------------------------------------
  describe('§9 W5-0-G7: dual-host authorization matrix', () => {
    const ORG_A = `${PFX}_g7_org_a`
    const ORG_B = `${PFX}_g7_org_b`
    const ADMIN_A = `${PFX}_g7_admin_a`
    const USER_A = `${PFX}_g7_user_a`
    const WORK_DATE = '2026-07-10'

    beforeAll(async () => {
      await seedMembership(ORG_A, ADMIN_A, true)
      await seedMembership(ORG_A, USER_A, true)
      const ownerB = `${PFX}_g7_org_b_owner`
      await seedMembership(ORG_B, ownerB, true)
      await seedRecord(ORG_A, USER_A, WORK_DATE, { status: 'normal' })
    }, 30000)

    it('admin host: delegated admin, own org ⇒ 200', async () => {
      const app = makeApp({ id: ADMIN_A })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance-admin/decision-trace?orgId=${ORG_A}&userId=${USER_A}&category=today_status&workDate=${WORK_DATE}`,
      )
      expect(res.status).toBe(200)
      expect(res.body.data.category).toBe('today_status')
    })

    it('admin host: delegated admin forges a foreign org ⇒ 403 BEFORE any trace SQL (zero transactions)', async () => {
      const app = makeApp({ id: ADMIN_A })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance-admin/decision-trace?orgId=${ORG_B}&userId=${USER_A}&category=today_status&workDate=${WORK_DATE}`,
      )
      expect(res.status).toBe(403)
      expect(res.body?.error?.code).toBe('FORBIDDEN')
      expect(transactionMock).not.toHaveBeenCalled()
    })

    it('admin host: platform admin override ⇒ 200 even for a non-member org, response still org-scoped', async () => {
      const platformAdminId = `${PFX}_g7_platform_admin`
      const app = makeApp({ id: platformAdminId })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance-admin/decision-trace?orgId=${ORG_A}&userId=${USER_A}&category=today_status&workDate=${WORK_DATE}`,
      )
      expect(res.status).toBe(200)
      expect(res.body.data.conclusion.status).toBe('normal')
    })

    it('self host: no active org membership ⇒ 403', async () => {
      const lonelyUser = `${PFX}_g7_lonely`
      await seedUser(lonelyUser, true)
      const app = makeApp({ id: lonelyUser })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(`/api/attendance/decision-trace?category=today_status&workDate=${WORK_DATE}`)
      expect(res.status).toBe(403)
    })

    it('self host: userId query parameter (spoofed) ⇒ 400, REGARDLESS of value — never silently ignored', async () => {
      const app = makeApp({ id: USER_A })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance/decision-trace?userId=${ADMIN_A}&category=today_status&workDate=${WORK_DATE}`,
      )
      expect(res.status).toBe(400)
      expect(res.body?.error?.code).toBe('USER_ID_NOT_ACCEPTED')
    })

    it('self host: single active org membership ⇒ auto-selected, 200, subject-locked to own data', async () => {
      const app = makeApp({ id: USER_A })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(`/api/attendance/decision-trace?category=today_status&workDate=${WORK_DATE}`)
      expect(res.status).toBe(200)
      expect(res.body.data.conclusion.status).toBe('normal')
    })

    it('self host: orgId not matching an active membership ⇒ 403', async () => {
      const app = makeApp({ id: USER_A })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance/decision-trace?orgId=${ORG_B}&category=today_status&workDate=${WORK_DATE}`,
      )
      expect(res.status).toBe(403)
    })

    describe('self multi-org four-leg (owner two-round-terminal-review P2-d)', () => {
      const ORG_M1 = `${PFX}_g7_org_m1`
      const ORG_M2 = `${PFX}_g7_org_m2`
      const ORG_M3 = `${PFX}_g7_org_m3`
      const MULTI_USER = `${PFX}_g7_multi`
      const MULTI_USER_REVERSED = `${PFX}_g7_multi_rev`
      const ZERO_ORG_USER = `${PFX}_g7_zero`

      beforeAll(async () => {
        await seedMembership(ORG_M1, MULTI_USER, true)
        await seedMembership(ORG_M2, MULTI_USER, true)
        // Reversed insertion order — proves ORG_ID_REQUIRED does not depend on row order (§4.1 leg 3).
        await seedMembership(ORG_M2, MULTI_USER_REVERSED, true)
        await seedMembership(ORG_M1, MULTI_USER_REVERSED, true)
        await seedUser(ZERO_ORG_USER, true)
        await seedRecord(ORG_M1, MULTI_USER, WORK_DATE, { status: 'late', lateMinutes: 10 })
        await seedRecord(ORG_M1, MULTI_USER_REVERSED, WORK_DATE, { status: 'late', lateMinutes: 10 })
      }, 30000)

      it('leg 1 — 0 active orgs ⇒ 403', async () => {
        const app = makeApp({ id: ZERO_ORG_USER })
        pinned.setApp(app)
        const res = await request(pinned.url()).get(`/api/attendance/decision-trace?category=today_status&workDate=${WORK_DATE}`)
        expect(res.status).toBe(403)
      })

      it('leg 2 — >1 active orgs, no orgId ⇒ 400 ORG_ID_REQUIRED, stable regardless of membership insertion order', async () => {
        const appA = makeApp({ id: MULTI_USER })
        pinned.setApp(appA)
        const resA = await request(pinned.url()).get(`/api/attendance/decision-trace?category=today_status&workDate=${WORK_DATE}`)
        expect(resA.status).toBe(400)
        expect(resA.body?.error?.code).toBe('ORG_ID_REQUIRED')

        const appB = makeApp({ id: MULTI_USER_REVERSED })
        pinned.setApp(appB)
        const resB = await request(pinned.url()).get(`/api/attendance/decision-trace?category=today_status&workDate=${WORK_DATE}`)
        expect(resB.status).toBe(400)
        expect(resB.body?.error?.code).toBe('ORG_ID_REQUIRED')
      })

      it('leg 3 — >1 active orgs, orgId matches a membership ⇒ 200', async () => {
        const app = makeApp({ id: MULTI_USER })
        pinned.setApp(app)
        const res = await request(pinned.url()).get(
          `/api/attendance/decision-trace?orgId=${ORG_M1}&category=today_status&workDate=${WORK_DATE}`,
        )
        expect(res.status).toBe(200)
        expect(res.body.data.conclusion.status).toBe('late')
      })

      it('leg 4 — >1 active orgs, orgId does NOT match any membership ⇒ 403', async () => {
        const app = makeApp({ id: MULTI_USER })
        pinned.setApp(app)
        const res = await request(pinned.url()).get(
          `/api/attendance/decision-trace?orgId=${ORG_M3}&category=today_status&workDate=${WORK_DATE}`,
        )
        expect(res.status).toBe(403)
      })
    })

    describe('two-user/same-org subject-constrained negative matrix (one leg per category)', () => {
      const ORG_TU = `${PFX}_g7_org_tu`
      const USER_SUBJECT = `${PFX}_g7_tu_subject`
      const USER_OTHER = `${PFX}_g7_tu_other`
      const OTHER_WORK_DATE = '2026-07-11'

      beforeAll(async () => {
        await seedMembership(ORG_TU, USER_SUBJECT, true)
        await seedMembership(ORG_TU, USER_OTHER, true)
        await seedRecord(ORG_TU, USER_OTHER, OTHER_WORK_DATE, { status: 'late', lateMinutes: 5 })
        await seedRecord(ORG_TU, USER_OTHER, `${OTHER_WORK_DATE}`, { status: 'partial' })
      }, 30000)

      function selfApp(userId: string) {
        const app = makeApp({ id: userId })
        pinned.setApp(app)
        return app
      }

      it('① today_status — subject queries a workDate that only OTHER has a record for ⇒ 200 + undeterminable, zero cross-user data', async () => {
        selfApp(USER_SUBJECT)
        const res = await request(pinned.url()).get(
          `/api/attendance/decision-trace?orgId=${ORG_TU}&category=today_status&workDate=${OTHER_WORK_DATE}`,
        )
        expect(res.status).toBe(200)
        expect(res.body.data.confidence).toBe('undeterminable')
        expect(res.body.data.conclusion.status).toBeNull()
        // OTHER's actual status value ('late') must never appear AS A VALUE — checked precisely
        // (not a bare substring match, which would false-positive on the `lateMinutes` KEY name
        // that legitimately appears, null-valued, in every ①/② conclusion shape).
        expect(res.body.data.conclusion.status).not.toBe('late')
        expect(JSON.stringify(res.body)).not.toContain('"status":"late"')
      })

      it('② late_early — same-org other-user workDate ⇒ 200 + undeterminable, zero cross-user data', async () => {
        selfApp(USER_SUBJECT)
        const res = await request(pinned.url()).get(
          `/api/attendance/decision-trace?orgId=${ORG_TU}&category=late_early&workDate=${OTHER_WORK_DATE}`,
        )
        expect(res.status).toBe(200)
        expect(res.body.data.confidence).toBe('undeterminable')
        expect(res.body.data.conclusion.lateMinutes).toBeNull()
      })

      it('③ missing_punch — same-org other-user workDate ⇒ 200 + undeterminable', async () => {
        selfApp(USER_SUBJECT)
        const res = await request(pinned.url()).get(
          `/api/attendance/decision-trace?orgId=${ORG_TU}&category=missing_punch&workDate=${OTHER_WORK_DATE}`,
        )
        expect(res.status).toBe(200)
        expect(res.body.data.confidence).toBe('undeterminable')
      })

      it('④ overtime_segmentation — OTHER-owned requestId ⇒ 404, byte-identical shape to a truly-nonexistent id', async () => {
        const otherRequestId = await seedOvertimeRequest(ORG_TU, USER_OTHER, OTHER_WORK_DATE, { minutes: 60 })
        selfApp(USER_SUBJECT)
        const resOther = await request(pinned.url()).get(
          `/api/attendance/decision-trace?orgId=${ORG_TU}&category=overtime_segmentation&requestId=${otherRequestId}`,
        )
        const resGhost = await request(pinned.url()).get(
          `/api/attendance/decision-trace?orgId=${ORG_TU}&category=overtime_segmentation&requestId=${randomUUID()}`,
        )
        expect(resOther.status).toBe(404)
        expect(resGhost.status).toBe(404)
        expect(resOther.body).toEqual(resGhost.body)
      })

      it('⑤ comp_time_balance — OTHER-owned lot never appears in subject-locked response (no lot-id targeting exists, so no 404 leg applies)', async () => {
        await seedLot(ORG_TU, USER_OTHER, 'annual_accrual', 'tu-other-lot')
        selfApp(USER_SUBJECT)
        const res = await request(pinned.url()).get(`/api/attendance/decision-trace?orgId=${ORG_TU}&category=comp_time_balance`)
        expect(res.status).toBe(200)
        expect(res.body.data.conclusion.lots).toEqual([])
      })

      it('⑥ approver_source — OTHER-owned instanceId ⇒ 404, byte-identical shape to a truly-nonexistent id', async () => {
        const otherInstanceId = await seedApprovalInstanceWithAssignment(ORG_TU, USER_OTHER, USER_OTHER, 'direct_manager')
        selfApp(USER_SUBJECT)
        const resOther = await request(pinned.url()).get(
          `/api/attendance/decision-trace?orgId=${ORG_TU}&category=approver_source&instanceId=${otherInstanceId}`,
        )
        const resGhost = await request(pinned.url()).get(
          `/api/attendance/decision-trace?orgId=${ORG_TU}&category=approver_source&instanceId=${randomUUID()}`,
        )
        expect(resOther.status).toBe(404)
        expect(resGhost.status).toBe(404)
        expect(resOther.body).toEqual(resGhost.body)
      })
    })
  })

  // -----------------------------------------------------------------------------------------------
  // G2: response allowlist + org-scoping negative controls
  // -----------------------------------------------------------------------------------------------
  describe('§9 W5-0-G2: allowlist + org-scoping negative controls', () => {
    const ORG_G2 = `${PFX}_g2_org`
    const USER_G2 = `${PFX}_g2_user`
    const OTHER_ORG_USER = `${PFX}_g2_other_org_user`
    const WORK_DATE = '2026-07-12'

    beforeAll(async () => {
      await seedMembership(ORG_G2, USER_G2, true)
      await seedRecord(ORG_G2, USER_G2, WORK_DATE, { status: 'normal', meta: { manual_result_edit: { correctedAgainst: {} } } })
      await pool.query(
        `INSERT INTO attendance_record_result_edits
           (org_id, record_id, user_id, work_date, before_status, after_status, before_snapshot, after_snapshot, reason, actor_user_id, idempotency_key)
         VALUES ($1, gen_random_uuid(), $2, $3, 'late', 'normal', '{}'::jsonb, '{}'::jsonb, 'appeal', $4, $5)`,
        [ORG_G2, USER_G2, WORK_DATE, OTHER_ORG_USER, `${PFX}:g2:${randomUUID()}`],
      )
    }, 30000)

    it('response key set is EXACT (today_status) — no extraneous keys leak through', async () => {
      const app = makeApp({ id: USER_G2 })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance/decision-trace?orgId=${ORG_G2}&category=today_status&workDate=${WORK_DATE}`,
      )
      expect(res.status).toBe(200)
      expect(Object.keys(res.body.data).sort()).toEqual(['basis', 'category', 'conclusion', 'confidence', 'reasonCode'])
    })

    it('auditRef.actor never leaks a raw user id — the actor who wrote the correction is identity-posture-resolved, not echoed as an id', async () => {
      const app = makeApp({ id: USER_G2 })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(
        `/api/attendance/decision-trace?orgId=${ORG_G2}&category=today_status&workDate=${WORK_DATE}`,
      )
      expect(res.status).toBe(200)
      const body = JSON.stringify(res.body)
      expect(body).not.toContain(OTHER_ORG_USER)
      const auditEnv = res.body.data.basis.find((b: { source: { ref: string } }) => b.source.ref === 'attendance_record_result_edits')
      expect(auditEnv.auditRef.actor.identityPosture).toBe('unknown') // OTHER_ORG_USER was never seeded into `users`
      expect(auditEnv.auditRef.actor.displayLabel).toBe('未知用户')
    })

    it('invalid category ⇒ 400 CATEGORY_INVALID (enum-strict, no silent fallback)', async () => {
      const app = makeApp({ id: USER_G2 })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(`/api/attendance/decision-trace?orgId=${ORG_G2}&category=not_a_real_category`)
      expect(res.status).toBe(400)
      expect(res.body?.error?.code).toBe('CATEGORY_INVALID')
    })

    it('missing category ⇒ 400 CATEGORY_REQUIRED', async () => {
      const app = makeApp({ id: USER_G2 })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(`/api/attendance/decision-trace?orgId=${ORG_G2}`)
      expect(res.status).toBe(400)
      expect(res.body?.error?.code).toBe('CATEGORY_REQUIRED')
    })
  })

  // -----------------------------------------------------------------------------------------------
  // G3: read-only seam reuse (the exhaustive 3-case Postgres proof lives in the W4-0 file)
  // -----------------------------------------------------------------------------------------------
  describe('§9 W5-0-G3: READ ONLY seam is REUSED, not re-derived', () => {
    it('runAttendanceDecisionTraceReadOnly IS runAttendanceSetupReadinessReadOnly (verbatim reuse)', () => {
      expect(runAttendanceDecisionTraceReadOnly).toBe(runAttendanceSetupReadinessReadOnly)
    })
    it('confirming instance: a write inside the seam is rejected by real Postgres', async () => {
      const orgId = `${PFX}_g3_org`
      await seedMembership(orgId, `${PFX}_g3_owner`, true)
      await expect(
        runAttendanceDecisionTraceReadOnly(async (q) => {
          await q(`UPDATE user_orgs SET is_active = is_active WHERE org_id = $1`, [orgId])
        }),
      ).rejects.toThrow(/read-only transaction/i)
    })
  })

  // -----------------------------------------------------------------------------------------------
  // G4: enum-strict + ⑤ discriminated union with a REAL raw-fixture negative
  // -----------------------------------------------------------------------------------------------
  describe('§9 W5-0-G4: ⑤ lot sourceResolution — raw fixture negative (direct lot INSERT, not via deductLeaveBalance)', () => {
    const ORG_G4 = `${PFX}_g4_org`
    const USER_G4 = `${PFX}_g4_user`

    beforeAll(async () => {
      await seedMembership(ORG_G4, USER_G4, true)
      // G4 fixture discipline (design lock §9 W5-0-G4 explicit warning): INSERT directly into
      // attendance_leave_balances.source_type — attendance_leave_balances.source_type has NO CHECK
      // constraint (zzzz20260603120000:34), so an arbitrary future-migration-shaped string is legal
      // here. `deductLeaveBalance` would instead write the EVENTS table's source_type column, which
      // this assertion does NOT read — that fixture shape would make the lot-side assertion pass
      // vacuously (nothing to classify), the exact trap the design lock names.
      await seedLot(ORG_G4, USER_G4, 'some_unmapped_future_source_kind', 'g4-raw')
    }, 30000)

    it('unmapped source_type ⇒ lot item is EXACTLY the unknown_source branch; the raw string is never echoed anywhere in the response', async () => {
      const app = makeApp({ id: USER_G4 })
      pinned.setApp(app)
      const res = await request(pinned.url()).get(`/api/attendance/decision-trace?orgId=${ORG_G4}&category=comp_time_balance`)
      expect(res.status).toBe(200)
      const lot = res.body.data.conclusion.lots[0]
      expect(Object.keys(lot).sort()).toEqual(['expiresAt', 'grantedAt', 'sourceResolution'])
      expect(lot.sourceResolution).toBe('unknown_source')
      expect(JSON.stringify(res.body)).not.toContain('some_unmapped_future_source_kind')
    })
  })

  // -----------------------------------------------------------------------------------------------
  // G5: not_in_effect vs undeterminable — two DIFFERENT postures against real system_configs
  // -----------------------------------------------------------------------------------------------
  describe('§9 W5-0-G5: not_in_effect ≠ undeterminable', () => {
    const ORG_G5 = `${PFX}_g5_org`
    const USER_G5 = `${PFX}_g5_user`
    const WORK_DATE = '2026-07-13'

    beforeAll(async () => {
      await seedMembership(ORG_G5, USER_G5, true)
      await seedOvertimeRequest(ORG_G5, USER_G5, WORK_DATE, { minutes: 90 }) // no valid snapshot ⇒ legacy
    }, 30000)

    it('positive control: engine OFF (dormant org, default settings) ⇒ engine-gate env is not_in_effect', async () => {
      await restoreAttendanceSettingsRow(pool, settingsRowSnapshot) // ensure default OFF
      const app = makeApp({ id: USER_G5 })
      pinned.setApp(app)
      const orgOwnerRequestId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM attendance_requests WHERE org_id = $1 AND user_id = $2 AND request_type='overtime' LIMIT 1`,
          [ORG_G5, USER_G5],
        )
      ).rows[0].id
      const res = await request(pinned.url()).get(
        `/api/attendance/decision-trace?orgId=${ORG_G5}&category=overtime_segmentation&requestId=${orgOwnerRequestId}`,
      )
      expect(res.status).toBe(200)
      const gateEnv = res.body.data.basis.find((b: { source: { ref: string } }) => b.source.ref === 'overtimeSegmentation')
      expect(gateEnv.version.posture).toBe('not_in_effect')
    })

    it('negative control: engine ON but no snapshot on THIS request ⇒ engine-gate env is undeterminable (a real gap, not a policy fact)', async () => {
      await writeSettingsRow({ overtimeSegmentation: { enabled: true } })
      const app = makeApp({ id: USER_G5 })
      pinned.setApp(app)
      const orgOwnerRequestId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM attendance_requests WHERE org_id = $1 AND user_id = $2 AND request_type='overtime' LIMIT 1`,
          [ORG_G5, USER_G5],
        )
      ).rows[0].id
      const res = await request(pinned.url()).get(
        `/api/attendance/decision-trace?orgId=${ORG_G5}&category=overtime_segmentation&requestId=${orgOwnerRequestId}`,
      )
      expect(res.status).toBe(200)
      const gateEnv = res.body.data.basis.find((b: { source: { ref: string } }) => b.source.ref === 'overtimeSegmentation')
      expect(gateEnv.version.posture).toBe('undeterminable')
    })
  })

  // -----------------------------------------------------------------------------------------------
  // G6: snapshot exclusivity — a request that WAS segmented stays byte-stable after the live rule
  // table changes (positive control lives here; the recompute-from-current MUTATION is a separate,
  // manually-applied source-code cut recorded in the PR body per the harness's mutation discipline).
  // -----------------------------------------------------------------------------------------------
  describe('§9 W5-0-G6: snapshot exclusivity — policy change does not alter an already-decided request', () => {
    const ORG_G6 = `${PFX}_g6_org`
    const USER_G6 = `${PFX}_g6_user`
    const WORK_DATE = '2026-07-14'

    it('byte-stable trace before/after the live attendance_overtime_rules row changes', async () => {
      await seedMembership(ORG_G6, USER_G6, true)
      const requestId = await seedOvertimeRequest(
        ORG_G6, USER_G6, WORK_DATE,
        {
          minutes: 120,
          overtimeSegmentation: {
            version: 1, engine: 'attendance_overtime_segmentation_v1', workDate: WORK_DATE, dayType: 'workday',
            calendar: { effectiveSource: 'calendar_default', holidayName: null },
            segments: { workdayMinutes: 120, restdayMinutes: 0, holidayMinutes: 0 }, totalMinutes: 120,
          },
        },
        '2026-07-15T10:00:00Z',
      )
      const app = makeApp({ id: USER_G6 })
      pinned.setApp(app)

      const before = await request(pinned.url()).get(
        `/api/attendance/decision-trace?orgId=${ORG_G6}&category=overtime_segmentation&requestId=${requestId}`,
      )
      expect(before.status).toBe(200)

      // Live policy churn AFTER the decision: insert a brand-new active overtime rule for this org.
      await pool.query(
        `INSERT INTO attendance_overtime_rules (org_id, name, min_minutes, is_active) VALUES ($1, $2, 999, true)`,
        [ORG_G6, `${PFX} g6 new rule`],
      )

      const after = await request(pinned.url()).get(
        `/api/attendance/decision-trace?orgId=${ORG_G6}&category=overtime_segmentation&requestId=${requestId}`,
      )
      expect(after.status).toBe(200)
      // The frozen segmentation conclusion/coverageNote must be byte-identical; only the (informational,
      // separately-labeled) rule_live environment's presence may legitimately change.
      expect(after.body.data.conclusion).toEqual(before.body.data.conclusion)
      expect(after.body.data.coverageNote).toEqual(before.body.data.coverageNote)
    })
  })
})
