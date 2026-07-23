/**
 * W3 / #4556 — writer-matrix zero-write coverage for shift segments (real DB, route-level).
 *
 * W3 has no authoritative calculator: even a mistakenly populated
 * ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED value cannot lift the guard.
 * multi-segment authoring is preview-only: every reference producer named in the W3
 * safety erratum must return a typed 422 and write nothing:
 *   fixed schedule apply/rebuild, automatic matching, draft/active assignment
 *   create/update, rotation rule create/update, generated rotation assignment
 *   create/update, shift-swap create/final approval, schedule-dispatch
 *   create/final approval — plus schedule publication (draft -> active reference).
 *
 * Delete returns a typed 409 with zero writes for every durable blocker and preserves
 * historical evidence; rejected/cancelled snapshots do not block, remain stored, and
 * reads redact the unresolvable raw shift UUID behind a neutral label.
 *
 * The concurrency legs prove the shared delete/reference lock protocol on real
 * PostgreSQL with pg_blocking_pids (never vacuously).
 *
 * House rules: unique org id per leg (shared DB stays clean); the global
 * attendance.settings row is snapshotted/restored around the auto-matching leg.
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { MetaSheetServer as MetaSheetServerType } from '../../src/index'
import {
  restoreAttendanceSettingsRow,
  snapshotAttendanceSettingsRow,
  type AttendanceSettingsRowSnapshot,
} from '../utils/attendance-settings-row'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const GUARD_CODE = 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED'
const DELETE_BLOCKED_CODE = 'ATTENDANCE_SHIFT_DELETE_BLOCKED'
const CONVERSION_BLOCKED_CODE = 'ATTENDANCE_SHIFT_SEGMENT_CONVERSION_BLOCKED'
const DELETED_LABEL = 'Deleted or unavailable shift'

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

const codeOf = (r: HttpResponse) => r.body?.error?.code

describeDb('W3 shift-segments writer matrix (real DB, route-level)', () => {
  let server: MetaSheetServerType | undefined
  let baseUrl = ''
  let pool: Pool
  let settingsSnapshot: AttendanceSettingsRowSnapshot

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) throw new Error('loopback port required')

    process.env.DATABASE_URL = dbUrl as string
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    // The automatic-matching leg enables this env gate per request; it stays unset otherwise.
    delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = '*'

    pool = new Pool({ connectionString: dbUrl })
    await pool.query('SELECT 1')
    settingsSnapshot = await snapshotAttendanceSettingsRow(pool)

    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('no TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
  }, 120000)

  afterAll(async () => {
    delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    if (server) await server.stop().catch(() => undefined)
    if (pool) {
      await restoreAttendanceSettingsRow(pool, settingsSnapshot).catch(() => undefined)
      await pool.end()
    }
  })

  function org(tag: string) {
    return `w3wm-${tag}-${randomUUID().slice(0, 8)}`
  }

  async function mintToken(userId: string): Promise<string> {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin,attendance:approve,attendance:import')}`,
    )
    expect(res.status, res.raw).toBe(200)
    return (res.body as { token?: string })?.token ?? ''
  }

  function authHeaders(token: string, orgId: string) {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-org-id': orgId }
  }

  async function postJson(pathname: string, token: string, orgId: string, payload: unknown): Promise<HttpResponse> {
    return requestJson(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: authHeaders(token, orgId),
      body: JSON.stringify(payload ?? {}),
    })
  }

  async function putJson(pathname: string, token: string, orgId: string, payload: unknown): Promise<HttpResponse> {
    return requestJson(`${baseUrl}${pathname}`, {
      method: 'PUT',
      headers: authHeaders(token, orgId),
      body: JSON.stringify(payload ?? {}),
    })
  }

  async function countRows(table: string, orgId: string, extra = ''): Promise<number> {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE org_id = $1 ${extra}`, [orgId])
    return Number(r.rows[0]?.n ?? 0)
  }

  async function segmentCount(shiftId: string): Promise<number> {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM attendance_shift_segments WHERE shift_id = $1', [shiftId])
    return Number(r.rows[0]?.n ?? 0)
  }

  async function createShiftViaApi(token: string, orgId: string, payload: Record<string, unknown>): Promise<HttpResponse> {
    return postJson('/api/attendance/shifts', token, orgId, payload)
  }

  /** Multi-segment shift M (08:00-12:00 + 13:00-17:00) authored via the preview-only API. */
  async function createMultiShift(token: string, orgId: string, name = 'Split'): Promise<string> {
    const res = await createShiftViaApi(token, orgId, {
      name,
      timezone: 'UTC',
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(res.status, res.raw).toBe(201)
    return res.body.data.id as string
  }

  async function seedPublishedAssignment(orgId: string, userId: string, shiftId: string, workDate: string): Promise<string> {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO attendance_shift_assignments
       (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active, publish_status, assignment_kind)
       VALUES ($1, $2, $3, $4, 0, $5, $5, true, 'published', 'regular')`,
      [id, orgId, userId, shiftId, workDate],
    )
    return id
  }

  /** Convert a single-segment shift to multi-segment beneath the API (simulates flag-ON legacy state). */
  async function injectSecondSegment(orgId: string, shiftId: string): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_shift_segments
       (id, org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
       VALUES ($1, $2, $3, 1, '13:00', 0, '17:00', 0)`,
      [randomUUID(), orgId, shiftId],
    )
  }

  /** Dispatch create requires exactly one active schedule_dispatch approval flow per org. */
  async function seedDispatchFlow(token: string, orgId: string): Promise<void> {
    const flow = await postJson('/api/attendance/approval-flows', token, orgId, {
      name: `${orgId}-dispatch-flow`,
      requestType: 'schedule_dispatch',
      isActive: true,
      steps: [],
    })
    expect(flow.status, flow.raw).toBe(201)
  }

  async function seedScheduleGroup(orgId: string): Promise<string> {
    const scheduleGroupId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_schedule_groups (id, org_id, name, code, source, is_active)
       VALUES ($1, $2, $3, $4, 'manual', true)`,
      [scheduleGroupId, orgId, `${orgId}-sg`, `${orgId}-sgc`],
    )
    return scheduleGroupId
  }

  it('creates a legacy-envelope shift with a persisted segment 0 (dual-write)', async () => {
    const orgId = org('create-legacy')
    const token = await mintToken(`${orgId}-admin`)
    const res = await createShiftViaApi(token, orgId, { name: 'Day', timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00' })
    expect(res.status, res.raw).toBe(201)
    const shift = res.body.data
    expect(shift.calculationMode).toBe('envelope')
    expect(shift.plannedMinutes).toBe(540)
    expect(shift.segments).toHaveLength(1)
    expect(shift.segments[0]).toMatchObject({ segmentIndex: 0, startTime: '09:00', endTime: '18:00', endDayOffset: 0 })
    expect(shift.capabilities.segmentCalculation).toMatchObject({
      enabled: false,
      defaultEnabled: false,
      authoritativeResults: false,
      multiSegmentAuthoring: 'preview_only',
      flag: 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED',
    })
    expect(await segmentCount(shift.id)).toBe(1)
  })

  it('creates a multi-segment shift with derived envelope and preview-only capability', async () => {
    const orgId = org('create-multi')
    const token = await mintToken(`${orgId}-admin`)
    const res = await createShiftViaApi(token, orgId, {
      name: 'Split',
      timezone: 'UTC',
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(res.status, res.raw).toBe(201)
    const shift = res.body.data
    expect(shift.calculationMode).toBe('segments')
    // R1: sum of segment minutes — the 60-minute break is never payable time.
    expect(shift.plannedMinutes).toBe(480)
    // Legacy envelope fields pass through mapShiftRow unchanged (pre-existing HH:MM:SS shape).
    expect(shift.workStartTime).toBe('08:00:00')
    expect(shift.workEndTime).toBe('17:00:00')
    expect(shift.isOvernight).toBe(false)
    expect(shift.segments).toHaveLength(2)
    expect(await segmentCount(shift.id)).toBe(2)

    const detail = await requestJson(`${baseUrl}/api/attendance/shifts/${shift.id}`, { headers: authHeaders(token, orgId) })
    expect(detail.status, detail.raw).toBe(200)
    expect(detail.body.data.segments).toHaveLength(2)

    const list = await requestJson(`${baseUrl}/api/attendance/shifts?page=1&pageSize=10`, { headers: authHeaders(token, orgId) })
    expect(list.status, list.raw).toBe(200)
    const listed = list.body.data.items.find((item: any) => item.id === shift.id)
    expect(listed.segments).toHaveLength(2)
    expect(listed.plannedMinutes).toBe(480)
  })

  it('rejects invalid segment arrays with a typed 422 and zero writes', async () => {
    const orgId = org('create-invalid')
    const token = await mintToken(`${orgId}-admin`)
    const before = await countRows('attendance_shifts', orgId)

    const overlap = await createShiftViaApi(token, orgId, {
      name: 'Bad',
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '11:00', endTime: '15:00' },
      ],
    })
    expect(overlap.status, overlap.raw).toBe(422)
    expect(codeOf(overlap)).toBe('ATTENDANCE_SHIFT_SEGMENTS_INVALID')

    const twoCrossings = await createShiftViaApi(token, orgId, {
      name: 'Bad2',
      segments: [
        { startTime: '20:00', endTime: '23:00', endDayOffset: 1 },
        { startTime: '23:30', endTime: '01:00', endDayOffset: 1 },
      ],
    })
    expect(twoCrossings.status, twoCrossings.raw).toBe(422)
    expect(codeOf(twoCrossings)).toBe('ATTENDANCE_SHIFT_SEGMENTS_INVALID')

    const ambiguous = await createShiftViaApi(token, orgId, {
      name: 'Bad3',
      workStartTime: '09:00',
      segments: [{ startTime: '09:00', endTime: '17:00' }],
    })
    expect(ambiguous.status, ambiguous.raw).toBe(422)
    expect(codeOf(ambiguous)).toBe('ATTENDANCE_SHIFT_SEGMENT_MODE_AMBIGUOUS')

    expect(await countRows('attendance_shifts', orgId)).toBe(before)
  })

  it('metadata-only PUT preserves segments; start/end-only PUT on a multi-segment shift is rejected', async () => {
    const orgId = org('put-modes')
    const token = await mintToken(`${orgId}-admin`)
    const multiId = await createMultiShift(token, orgId)

    const metadata = await putJson(`/api/attendance/shifts/${multiId}`, token, orgId, { name: 'Split Renamed', lateGraceMinutes: 7 })
    expect(metadata.status, metadata.raw).toBe(200)
    expect(metadata.body.data.segments).toHaveLength(2)
    expect(metadata.body.data.name).toBe('Split Renamed')
    expect(metadata.body.data.plannedMinutes).toBe(480)

    const collapse = await putJson(`/api/attendance/shifts/${multiId}`, token, orgId, { workStartTime: '07:00', workEndTime: '19:00' })
    expect(collapse.status, collapse.raw).toBe(422)
    expect(codeOf(collapse)).toBe('ATTENDANCE_SHIFT_ENVELOPE_COLLAPSE_REJECTED')
    const persisted = await pool.query(
      'SELECT start_time, end_time FROM attendance_shift_segments WHERE shift_id = $1 ORDER BY segment_index',
      [multiId],
    )
    expect(persisted.rows.map((row) => `${row.start_time}-${row.end_time}`)).toEqual(['08:00:00-12:00:00', '13:00:00-17:00:00'])

    // Legacy envelope write on a single-segment shift updates envelope and segment 0 together.
    const single = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string
    const envelopePut = await putJson(`/api/attendance/shifts/${singleId}`, token, orgId, { workStartTime: '10:00', workEndTime: '19:00' })
    expect(envelopePut.status, envelopePut.raw).toBe(200)
    expect(envelopePut.body.data.workStartTime).toBe('10:00:00')
    expect(envelopePut.body.data.segments[0]).toMatchObject({ startTime: '10:00', endTime: '19:00' })

    // Segments PUT on an UNREFERENCED shift may convert 1 -> 2 (authoring preview).
    const convert = await putJson(`/api/attendance/shifts/${singleId}`, token, orgId, {
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(convert.status, convert.raw).toBe(200)
    expect(convert.body.data.calculationMode).toBe('segments')
    expect(convert.body.data.workStartTime).toBe('08:00:00')
    expect(convert.body.data.workEndTime).toBe('17:00:00')
  })

  it('blocks converting one segment to multiple while an active assignment references the shift', async () => {
    const orgId = org('put-conversion')
    const token = await mintToken(`${orgId}-admin`)
    const created = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const shiftId = created.body.data.id as string
    await seedPublishedAssignment(orgId, `${orgId}-worker`, shiftId, '2049-06-10')

    const res = await putJson(`/api/attendance/shifts/${shiftId}`, token, orgId, {
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(res.status, res.raw).toBe(409)
    expect(codeOf(res)).toBe(CONVERSION_BLOCKED_CODE)
    expect(await segmentCount(shiftId)).toBe(1)
  })

  it('rename + rejected segment conversion is atomic and leaves legacy rotation rules untouched', async () => {
    const orgId = org('put-rename-atomic')
    const token = await mintToken(`${orgId}-admin`)
    const created = await createShiftViaApi(token, orgId, {
      name: 'Legacy Named',
      workStartTime: '09:00',
      workEndTime: '18:00',
    })
    const shiftId = created.body.data.id as string
    await seedPublishedAssignment(orgId, `${orgId}-worker`, shiftId, '2049-06-10')
    const ruleId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'Legacy Rule', 'UTC', $3::jsonb, true)`,
      [ruleId, orgId, JSON.stringify(['Legacy Named'])],
    )

    const rejected = await putJson(`/api/attendance/shifts/${shiftId}`, token, orgId, {
      name: 'Renamed',
      segments: [
        { startTime: '08:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '17:00' },
      ],
    })
    expect(rejected.status, rejected.raw).toBe(409)
    expect(codeOf(rejected)).toBe(CONVERSION_BLOCKED_CODE)

    const persisted = await pool.query(
      `SELECT s.name, r.shift_sequence
         FROM attendance_shifts s
         JOIN attendance_rotation_rules r ON r.id = $2
        WHERE s.id = $1`,
      [shiftId, ruleId],
    )
    expect(persisted.rows[0].name).toBe('Legacy Named')
    expect(persisted.rows[0].shift_sequence).toEqual(['Legacy Named'])
    expect(await segmentCount(shiftId)).toBe(1)
  })

  it('rename normalization rolls back when the later shift update fails', async () => {
    const orgId = org('rename-update-failure')
    const token = await mintToken(`${orgId}-admin`)
    const created = await createShiftViaApi(token, orgId, {
      name: 'Atomic Legacy Name',
      workStartTime: '09:00',
      workEndTime: '18:00',
    })
    const shiftId = created.body.data.id as string
    const ruleId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'Atomic Legacy Rule', 'UTC', $3::jsonb, true)`,
      [ruleId, orgId, JSON.stringify(['Atomic Legacy Name'])],
    )

    await pool.query(`
      CREATE OR REPLACE FUNCTION w3wm_fail_named_shift_update()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.name LIKE 'W3WM_FAIL_%' THEN
          RAISE EXCEPTION 'forced W3 shift update failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await pool.query('DROP TRIGGER IF EXISTS w3wm_fail_named_shift_update ON attendance_shifts')
    await pool.query(`
      CREATE TRIGGER w3wm_fail_named_shift_update
      BEFORE UPDATE ON attendance_shifts
      FOR EACH ROW EXECUTE FUNCTION w3wm_fail_named_shift_update()
    `)

    try {
      const rejected = await putJson(`/api/attendance/shifts/${shiftId}`, token, orgId, {
        name: 'W3WM_FAIL_Renamed',
      })
      expect(rejected.status, rejected.raw).toBe(500)

      const persisted = await pool.query(
        `SELECT s.name, r.shift_sequence
           FROM attendance_shifts s
           JOIN attendance_rotation_rules r ON r.id = $2
          WHERE s.id = $1`,
        [shiftId, ruleId],
      )
      expect(persisted.rows[0].name).toBe('Atomic Legacy Name')
      expect(persisted.rows[0].shift_sequence).toEqual(['Atomic Legacy Name'])
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS w3wm_fail_named_shift_update ON attendance_shifts')
      await pool.query('DROP FUNCTION IF EXISTS w3wm_fail_named_shift_update()')
    }
  })

  it('cross-org: a shift is invisible and unreferenceable from another org', async () => {
    const orgX = org('xorg-x')
    const orgY = org('xorg-y')
    const tokenX = await mintToken(`${orgX}-admin`)
    const tokenY = await mintToken(`${orgY}-admin`)
    const multiId = await createMultiShift(tokenX, orgX)

    const detail = await requestJson(`${baseUrl}/api/attendance/shifts/${multiId}`, { headers: authHeaders(tokenY, orgY) })
    expect(detail.status, detail.raw).toBe(404)

    const assignment = await postJson('/api/attendance/assignments', tokenY, orgY, {
      userId: `${orgY}-worker`,
      shiftId: multiId,
      startDate: '2049-06-10',
    })
    expect(assignment.status, assignment.raw).toBe(404)
    expect(codeOf(assignment)).toBe('NOT_FOUND')
    expect(await countRows('attendance_shift_assignments', orgY)).toBe(0)
  })

  it('matrix: draft + active assignment create/update return typed 422 with zero writes', async () => {
    const orgId = org('matrix-assign')
    const token = await mintToken(`${orgId}-admin`)
    const multiId = await createMultiShift(token, orgId)
    const single = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string

    const draftCreate = await postJson('/api/attendance/schedule-drafts/assignments', token, orgId, {
      userId: `${orgId}-worker`,
      shiftId: multiId,
      startDate: '2049-06-10',
    })
    expect(draftCreate.status, draftCreate.raw).toBe(422)
    expect(codeOf(draftCreate)).toBe(GUARD_CODE)

    const activeCreate = await postJson('/api/attendance/assignments', token, orgId, {
      userId: `${orgId}-worker`,
      shiftId: multiId,
      startDate: '2049-06-10',
    })
    expect(activeCreate.status, activeCreate.raw).toBe(422)
    expect(codeOf(activeCreate)).toBe(GUARD_CODE)
    expect(await countRows('attendance_shift_assignments', orgId)).toBe(0)

    // Update legs: a valid row on the single shift must not be re-pointed at M.
    const draft = await postJson('/api/attendance/schedule-drafts/assignments', token, orgId, {
      userId: `${orgId}-worker`,
      shiftId: singleId,
      startDate: '2049-06-10',
    })
    expect(draft.status, draft.raw).toBe(201)
    const draftId = draft.body.data.assignment.id as string
    const draftUpdate = await putJson(`/api/attendance/schedule-drafts/assignments/${draftId}`, token, orgId, { shiftId: multiId })
    expect(draftUpdate.status, draftUpdate.raw).toBe(422)
    expect(codeOf(draftUpdate)).toBe(GUARD_CODE)

    const active = await postJson('/api/attendance/assignments', token, orgId, {
      userId: `${orgId}-worker-2`,
      shiftId: singleId,
      startDate: '2049-06-10',
    })
    expect(active.status, active.raw).toBe(201)
    const activeId = active.body.data.assignment.id as string
    const activeUpdate = await putJson(`/api/attendance/assignments/${activeId}`, token, orgId, { shiftId: multiId })
    expect(activeUpdate.status, activeUpdate.raw).toBe(422)
    expect(codeOf(activeUpdate)).toBe(GUARD_CODE)

    const rows = await pool.query(
      'SELECT id, shift_id FROM attendance_shift_assignments WHERE org_id = $1',
      [orgId],
    )
    expect(rows.rows).toHaveLength(2)
    for (const row of rows.rows) expect(row.shift_id).toBe(singleId)
  })

  it('matrix: rotation rule create/update return typed 422 with zero writes', async () => {
    const orgId = org('matrix-rules')
    const token = await mintToken(`${orgId}-admin`)
    const multiId = await createMultiShift(token, orgId)
    const single = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string

    const create = await postJson('/api/attendance/rotation-rules', token, orgId, {
      name: 'Rotate',
      shiftSequence: [singleId, multiId],
    })
    expect(create.status, create.raw).toBe(422)
    expect(codeOf(create)).toBe(GUARD_CODE)
    expect(await countRows('attendance_rotation_rules', orgId)).toBe(0)

    const okRule = await postJson('/api/attendance/rotation-rules', token, orgId, {
      name: 'Rotate',
      shiftSequence: [singleId],
    })
    expect(okRule.status, okRule.raw).toBe(201)
    const ruleId = okRule.body.data.id as string
    const update = await putJson(`/api/attendance/rotation-rules/${ruleId}`, token, orgId, {
      shiftSequence: [singleId, multiId],
    })
    expect(update.status, update.raw).toBe(422)
    expect(codeOf(update)).toBe(GUARD_CODE)
    const persisted = await pool.query('SELECT shift_sequence FROM attendance_rotation_rules WHERE id = $1', [ruleId])
    expect(persisted.rows[0].shift_sequence).toEqual([singleId])
  })

  it('matrix: generated rotation assignment create/update (draft + active) return typed 422 with zero writes', async () => {
    const orgId = org('matrix-rotasgn')
    const token = await mintToken(`${orgId}-admin`)
    const multiId = await createMultiShift(token, orgId)
    // Rule seeded directly: the API create would (correctly) 422 on M.
    const ruleId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'Rotate', 'UTC', $3::jsonb, true)`,
      [ruleId, orgId, JSON.stringify([multiId])],
    )

    const draftCreate = await postJson('/api/attendance/schedule-drafts/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker`,
      rotationRuleId: ruleId,
      startDate: '2049-06-10',
    })
    expect(draftCreate.status, draftCreate.raw).toBe(422)
    expect(codeOf(draftCreate)).toBe(GUARD_CODE)

    const activeCreate = await postJson('/api/attendance/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker`,
      rotationRuleId: ruleId,
      startDate: '2049-06-10',
    })
    expect(activeCreate.status, activeCreate.raw).toBe(422)
    expect(codeOf(activeCreate)).toBe(GUARD_CODE)
    expect(await countRows('attendance_rotation_assignments', orgId)).toBe(0)

    // Update legs: valid rows on a single-shift rule must not survive the rule gaining M.
    const single = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string
    const singleRuleId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'RotateSingle', 'UTC', $3::jsonb, true)`,
      [singleRuleId, orgId, JSON.stringify([singleId])],
    )
    const draft = await postJson('/api/attendance/schedule-drafts/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker`,
      rotationRuleId: singleRuleId,
      startDate: '2049-06-10',
    })
    expect(draft.status, draft.raw).toBe(201)
    const draftId = draft.body.data.assignment.id as string
    const active = await postJson('/api/attendance/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker-2`,
      rotationRuleId: singleRuleId,
      startDate: '2049-06-10',
    })
    expect(active.status, active.raw).toBe(201)
    const activeId = active.body.data.assignment.id as string

    // The rule's sequence gains M beneath the API (flag-ON legacy state); both updates must fail closed.
    await pool.query('UPDATE attendance_rotation_rules SET shift_sequence = $2::jsonb WHERE id = $1', [singleRuleId, JSON.stringify([singleId, multiId])])
    const draftUpdate = await putJson(`/api/attendance/schedule-drafts/rotation-assignments/${draftId}`, token, orgId, { startDate: '2049-06-11' })
    expect(draftUpdate.status, draftUpdate.raw).toBe(422)
    expect(codeOf(draftUpdate)).toBe(GUARD_CODE)
    const activeUpdate = await putJson(`/api/attendance/rotation-assignments/${activeId}`, token, orgId, { startDate: '2049-06-11' })
    expect(activeUpdate.status, activeUpdate.raw).toBe(422)
    expect(codeOf(activeUpdate)).toBe(GUARD_CODE)
    const dates = await pool.query(
      'SELECT id, start_date::text AS start_date FROM attendance_rotation_assignments WHERE org_id = $1 ORDER BY id',
      [orgId],
    )
    for (const row of dates.rows) expect(String(row.start_date).slice(0, 10)).toBe('2049-06-10')
  })

  it('legacy duplicate-name rotation references fail closed when any matching shift is multi-segment', async () => {
    const orgId = org('matrix-legacy-name')
    const token = await mintToken(`${orgId}-admin`)
    await createShiftViaApi(token, orgId, {
      name: 'Duplicate',
      workStartTime: '09:00',
      workEndTime: '18:00',
    })
    await createMultiShift(token, orgId, 'Duplicate')
    const ruleId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'Legacy Duplicate Rule', 'UTC', $3::jsonb, true)`,
      [ruleId, orgId, JSON.stringify(['Duplicate'])],
    )

    const create = await postJson('/api/attendance/rotation-assignments', token, orgId, {
      userId: `${orgId}-worker`,
      rotationRuleId: ruleId,
      startDate: '2049-06-10',
    })
    expect(create.status, create.raw).toBe(422)
    expect(codeOf(create)).toBe(GUARD_CODE)
    expect(await countRows('attendance_rotation_assignments', orgId)).toBe(0)
  })

  it('matrix: fixed schedule apply and rebuild return typed 422 with zero writes', async () => {
    const orgId = org('matrix-fixed')
    const token = await mintToken(`${orgId}-admin`)
    const multiId = await createMultiShift(token, orgId)

    const group = await postJson('/api/attendance/groups', token, orgId, {
      name: `${orgId}-group`,
      timezone: 'UTC',
      attendanceType: 'fixed_shift',
    })
    expect(group.status, group.raw).toBe(200)
    const groupId = group.body.data.id as string
    const members = await postJson(`/api/attendance/groups/${groupId}/members`, token, orgId, { userIds: [`${orgId}-worker`] })
    expect(members.status, members.raw).toBe(200)

    const apply = await postJson(`/api/attendance/groups/${groupId}/fixed-schedule/apply`, token, orgId, {
      shiftId: multiId,
      startDate: '2049-06-01',
      endDate: '2049-06-30',
    })
    expect(apply.status, apply.raw).toBe(422)
    expect(codeOf(apply)).toBe(GUARD_CODE)

    const rebuild = await postJson(`/api/attendance/groups/${groupId}/fixed-schedule/rebuild`, token, orgId, {
      shiftId: multiId,
      startDate: '2049-06-01',
      endDate: '2049-06-30',
    })
    expect(rebuild.status, rebuild.raw).toBe(422)
    expect(codeOf(rebuild)).toBe(GUARD_CODE)
    expect(await countRows('attendance_shift_assignments', orgId)).toBe(0)
  })

  it('matrix: shift-swap create returns typed 422 with zero writes', async () => {
    const orgId = org('matrix-swap')
    const token = await mintToken(`${orgId}-admin`)
    const multiId = await createMultiShift(token, orgId)
    const single = await createShiftViaApi(token, orgId, { name: 'Other', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string
    const assignmentA = await seedPublishedAssignment(orgId, `${orgId}-a`, multiId, '2049-06-14')
    const assignmentB = await seedPublishedAssignment(orgId, `${orgId}-b`, singleId, '2049-06-15')

    const create = await postJson('/api/attendance/shift-swap-requests', token, orgId, {
      requesterAssignmentId: assignmentA,
      counterpartyAssignmentId: assignmentB,
    })
    expect(create.status, create.raw).toBe(422)
    expect(codeOf(create)).toBe(GUARD_CODE)
    expect(await countRows('attendance_shift_swap_requests', orgId)).toBe(0)
    expect(await countRows('attendance_requests', orgId)).toBe(0)
    await pool.query('DELETE FROM attendance_shift_assignments WHERE org_id = $1', [orgId])
  })

  it('matrix: schedule-dispatch create returns typed 422 with zero writes', async () => {
    const orgId = org('matrix-dispatch')
    const token = await mintToken(`${orgId}-admin`)
    const multiId = await createMultiShift(token, orgId)
    await seedDispatchFlow(token, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)

    const create = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
      userId: `${orgId}-worker`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: multiId,
      startDate: '2049-06-10',
      endDate: '2049-06-10',
    })
    expect(create.status, create.raw).toBe(422)
    expect(codeOf(create)).toBe(GUARD_CODE)
    expect(await countRows('attendance_schedule_dispatch_requests', orgId)).toBe(0)
    expect(await countRows('attendance_requests', orgId)).toBe(0)
  })

  it('matrix: schedule publication fails closed when a draft shift became multi-segment', async () => {
    const orgId = org('matrix-publish')
    const token = await mintToken(`${orgId}-admin`)
    const single = await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })
    const singleId = single.body.data.id as string
    const draft = await postJson('/api/attendance/schedule-drafts/assignments', token, orgId, {
      userId: `${orgId}-worker`,
      shiftId: singleId,
      startDate: '2049-06-10',
    })
    expect(draft.status, draft.raw).toBe(201)
    const draftId = draft.body.data.assignment.id as string

    // The shift is converted 1 -> 2 beneath the API (drafts deliberately do not block
    // authoring); publication is the last fail-closed gate before an active reference exists.
    await injectSecondSegment(orgId, singleId)
    const publish = await postJson('/api/attendance/schedule-publications', token, orgId, { assignmentIds: [draftId] })
    expect(publish.status, publish.raw).toBe(422)
    expect(codeOf(publish)).toBe(GUARD_CODE)
    const persisted = await pool.query('SELECT publish_status FROM attendance_shift_assignments WHERE id = $1', [draftId])
    expect(persisted.rows[0].publish_status).toBe('draft')
  })

  it('matrix: shift-swap final approval fails closed after the source shift became multi-segment', async () => {
    const orgId = org('matrix-swap-final')
    const requesterToken = await mintToken(`${orgId}-a`)
    const counterpartyToken = await mintToken(`${orgId}-b`)
    const shiftA = (await createShiftViaApi(requesterToken, orgId, { name: 'A', workStartTime: '09:00', workEndTime: '13:00' })).body.data.id as string
    const shiftB = (await createShiftViaApi(requesterToken, orgId, { name: 'B', workStartTime: '14:00', workEndTime: '18:00' })).body.data.id as string
    const assignmentA = await seedPublishedAssignment(orgId, `${orgId}-a`, shiftA, '2049-06-14')
    const assignmentB = await seedPublishedAssignment(orgId, `${orgId}-b`, shiftB, '2049-06-15')

    const create = await postJson('/api/attendance/shift-swap-requests', requesterToken, orgId, {
      requesterAssignmentId: assignmentA,
      counterpartyAssignmentId: assignmentB,
    })
    expect(create.status, create.raw).toBe(201)
    const requestId = create.body.data.request.id as string
    const accept = await postJson(`/api/attendance/shift-swap-requests/${requestId}/accept`, counterpartyToken, orgId, {})
    expect(accept.status, accept.raw).toBe(200)

    // The requester shift became multi-segment after the snapshot was taken.
    await injectSecondSegment(orgId, shiftA)
    const approve = await postJson(`/api/attendance/requests/${requestId}/approve`, requesterToken, orgId, { comment: 'go' })
    expect(approve.status, approve.raw).toBe(422)
    expect(codeOf(approve)).toBe(GUARD_CODE)

    const state = await pool.query(
      `SELECT r.status, d.requester_replacement_assignment_id, d.counterparty_replacement_assignment_id, d.finalized_at
         FROM attendance_requests r
         JOIN attendance_shift_swap_requests d ON d.request_id = r.id
        WHERE r.id = $1`,
      [requestId],
    )
    expect(state.rows[0].status).toBe('pending')
    expect(state.rows[0].requester_replacement_assignment_id).toBeNull()
    expect(state.rows[0].counterparty_replacement_assignment_id).toBeNull()
    expect(state.rows[0].finalized_at).toBeNull()
    // Zero writes: only the two seeded source assignments exist.
    expect(await countRows('attendance_shift_assignments', orgId)).toBe(2)
  })

  it('matrix: schedule-dispatch final approval fails closed after the target shift became multi-segment', async () => {
    const orgId = org('matrix-dispatch-final')
    const token = await mintToken(`${orgId}-admin`)
    const shiftId = (await createShiftViaApi(token, orgId, { name: 'Day', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    await seedDispatchFlow(token, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)

    const create = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
      userId: `${orgId}-worker`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: '2049-06-10',
      endDate: '2049-06-10',
    })
    expect(create.status, create.raw).toBe(201)
    const requestId = create.body.data.request.id as string

    await injectSecondSegment(orgId, shiftId)
    const approve = await postJson(`/api/attendance/requests/${requestId}/approve`, token, orgId, { comment: 'go' })
    expect(approve.status, approve.raw).toBe(422)
    expect(codeOf(approve)).toBe(GUARD_CODE)

    const state = await pool.query(
      `SELECT r.status, d.publish_status, d.assignment_ids, d.finalized_at
         FROM attendance_schedule_dispatch_requests d
         JOIN attendance_requests r ON r.id = d.request_id
        WHERE r.id = $1`,
      [requestId],
    )
    expect(state.rows[0].status).toBe('pending')
    expect(state.rows[0].publish_status).toBe('pending')
    expect(state.rows[0].finalized_at).toBeNull()
    expect(await countRows('attendance_shift_assignments', orgId)).toBe(0)
  })

  it('matrix: automatic matching apply returns typed 422 with zero writes', async () => {
    const orgId = org('matrix-automatch')
    const token = await mintToken(`${orgId}-admin`)
    process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED = 'true'
    try {
      const settings = await putJson('/api/attendance/settings', token, orgId, {
        autoShiftMatching: {
          enabled: true,
          mode: 'apply',
          maxToleranceMinutes: 30,
          minConfidenceToApply: 'high',
          autoWrite: { enabled: false, lookaheadDays: 1, maxAssignmentsPerRun: 25, minConfidence: 'high' },
        },
      })
      expect(settings.status, settings.raw).toBe(200)

      const multiId = await createMultiShift(token, orgId)
      const userId = `${orgId}-worker`
      const workDate = '2049-06-10'
      // Automatic matching only considers users in a scheduled_shift group.
      const group = await postJson('/api/attendance/groups', token, orgId, {
        name: `${orgId}-group`,
        timezone: 'UTC',
        attendanceType: 'scheduled_shift',
      })
      expect(group.status, group.raw).toBe(200)
      const groupId = group.body.data.id as string
      const members = await postJson(`/api/attendance/groups/${groupId}/members`, token, orgId, { userIds: [userId] })
      expect(members.status, members.raw).toBe(200)
      const inId = randomUUID()
      const outId = randomUUID()
      await pool.query(
        `INSERT INTO attendance_events (id, user_id, org_id, work_date, occurred_at, event_type, source, timezone, location, meta)
         VALUES ($1, $3, $4, $5, $6, 'check_in', 'integration-test', 'UTC', '{}'::jsonb, '{}'::jsonb),
                ($2, $3, $4, $5, $7, 'check_out', 'integration-test', 'UTC', '{}'::jsonb, '{}'::jsonb)`,
        [inId, outId, userId, orgId, workDate, `${workDate}T08:00:00.000Z`, `${workDate}T17:00:00.000Z`],
      )

      const preview = await postJson('/api/attendance/auto-shift-matching/preview', token, orgId, {
        userIds: [userId],
        from: workDate,
        to: workDate,
      })
      expect(preview.status, preview.raw).toBe(200)
      const candidate = (preview.body.data.items ?? []).find((item: any) => item.candidateShiftId === multiId)
      expect(candidate, preview.raw).toBeTruthy()

      const apply = await postJson('/api/attendance/auto-shift-matching/apply', token, orgId, {
        items: [{
          userId,
          workDate,
          candidateShiftId: multiId,
          evidence: { eventIds: candidate.evidence?.eventIds ?? [inId, outId] },
        }],
      })
      expect(apply.status, apply.raw).toBe(422)
      expect(codeOf(apply)).toBe(GUARD_CODE)
      expect(await countRows('attendance_shift_assignments', orgId)).toBe(0)
    } finally {
      delete process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED
      await restoreAttendanceSettingsRow(pool, settingsSnapshot).catch(() => undefined)
    }
  })

  it('delete: typed 409 with zero writes for every durable blocker class', async () => {
    const orgId = org('delete-blockers')
    const token = await mintToken(`${orgId}-admin`)

    async function expectDeleteBlocked(shiftId: string, blocker: string) {
      const segmentsBefore = await segmentCount(shiftId)
      const res = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftId}`, {
        method: 'DELETE',
        headers: authHeaders(token, orgId),
      })
      expect(res.status, `${blocker}: ${res.raw}`).toBe(409)
      expect(codeOf(res)).toBe(DELETE_BLOCKED_CODE)
      const shiftStillThere = await pool.query('SELECT 1 FROM attendance_shifts WHERE id = $1', [shiftId])
      expect(shiftStillThere.rows).toHaveLength(1)
      expect(await segmentCount(shiftId)).toBe(segmentsBefore)
    }

    // (a) ANY assignment row, including ended/inactive history.
    const shiftA = (await createShiftViaApi(token, orgId, { name: 'Del A', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    await pool.query(
      `INSERT INTO attendance_shift_assignments
       (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active)
       VALUES ($1, $2, $3, $4, 0, '2020-01-01', '2020-01-02', false)`,
      [randomUUID(), orgId, `${orgId}-hist`, shiftA],
    )
    await expectDeleteBlocked(shiftA, 'historical assignment')

    // (b) rotation rule referencing the shift id.
    const shiftB = (await createShiftViaApi(token, orgId, { name: 'Del B', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    const rule = await postJson('/api/attendance/rotation-rules', token, orgId, { name: 'DelRuleB', shiftSequence: [shiftB] })
    expect(rule.status, rule.raw).toBe(201)
    await expectDeleteBlocked(shiftB, 'rotation rule id reference')

    // (c) rotation rule referencing the legacy shift NAME.
    const shiftC = (await createShiftViaApi(token, orgId, { name: 'Del C', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    await pool.query(
      `INSERT INTO attendance_rotation_rules (id, org_id, name, timezone, shift_sequence, is_active)
       VALUES ($1, $2, 'DelRuleC', 'UTC', $3::jsonb, true)`,
      [randomUUID(), orgId, JSON.stringify(['Del C'])],
    )
    await expectDeleteBlocked(shiftC, 'rotation rule legacy name reference')

    // (d) pending swap requester/counterparty snapshot.
    const shiftD1 = (await createShiftViaApi(token, orgId, { name: 'Del D1', workStartTime: '09:00', workEndTime: '13:00' })).body.data.id as string
    const shiftD2 = (await createShiftViaApi(token, orgId, { name: 'Del D2', workStartTime: '14:00', workEndTime: '18:00' })).body.data.id as string
    const assignmentD1 = await seedPublishedAssignment(orgId, `${orgId}-da`, shiftD1, '2049-06-14')
    const assignmentD2 = await seedPublishedAssignment(orgId, `${orgId}-db`, shiftD2, '2049-06-15')
    const swap = await postJson('/api/attendance/shift-swap-requests', token, orgId, {
      requesterAssignmentId: assignmentD1,
      counterpartyAssignmentId: assignmentD2,
    })
    expect(swap.status, swap.raw).toBe(201)

    // The pending swap snapshot is itself a durable blocker: the delete error details
    // must name BOTH the assignment rows and the swap reference class.
    const swapDelete = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftD1}`, {
      method: 'DELETE',
      headers: authHeaders(token, orgId),
    })
    expect(swapDelete.status, swapDelete.raw).toBe(409)
    expect(codeOf(swapDelete)).toBe(DELETE_BLOCKED_CODE)
    const blockerFields = (swapDelete.body?.error?.details ?? []).map((detail: any) => detail.field)
    expect(blockerFields).toContain('shift_assignments')
    expect(blockerFields).toContain('shift_swap_requests')

    // (e) pending dispatch target.
    const shiftE = (await createShiftViaApi(token, orgId, { name: 'Del E', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    await seedDispatchFlow(token, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)
    const dispatch = await postJson('/api/attendance/schedule-dispatch-requests', token, orgId, {
      userId: `${orgId}-worker`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftE,
      startDate: '2049-06-10',
      endDate: '2049-06-10',
    })
    expect(dispatch.status, dispatch.raw).toBe(201)
    await expectDeleteBlocked(shiftE, 'pending dispatch target')
  })

  it('delete: rejected/cancelled evidence does not block, remains stored, and reads redact the raw UUID', async () => {
    const orgId = org('delete-evidence')
    const requesterToken = await mintToken(`${orgId}-a`)
    const shiftA = (await createShiftViaApi(requesterToken, orgId, { name: 'Ev A', workStartTime: '09:00', workEndTime: '13:00' })).body.data.id as string
    const shiftB = (await createShiftViaApi(requesterToken, orgId, { name: 'Ev B', workStartTime: '14:00', workEndTime: '18:00' })).body.data.id as string

    // Rejected swap snapshot referencing shiftA. The swap snapshot's assignment FKs
    // must stay valid, so the dummy assignments point at the SURVIVING shift; the
    // snapshot's requester_shift_id (a plain NOT NULL column without FK) points at A.
    // This is exactly the legacy state the erratum describes: historical evidence
    // whose shift no longer exists, with no live assignment reference to A.
    const swapRequestId = randomUUID()
    const assignmentA = await seedPublishedAssignment(orgId, `${orgId}-a`, shiftB, '2049-06-14')
    const assignmentB = await seedPublishedAssignment(orgId, `${orgId}-b`, shiftB, '2049-06-15')
    await pool.query(
      `INSERT INTO attendance_requests (id, user_id, org_id, work_date, request_type, reason, status)
       VALUES ($1, $2, $3, '2049-06-14', 'shift_swap', 'w3 evidence', 'rejected')`,
      [swapRequestId, `${orgId}-a`, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_shift_swap_requests
       (request_id, org_id, requester_user_id, counterparty_user_id,
        requester_assignment_id, counterparty_assignment_id,
        requester_work_date, counterparty_work_date,
        requester_shift_id, counterparty_shift_id,
        requester_slot_index, counterparty_slot_index,
        requester_start_date, requester_end_date,
        counterparty_start_date, counterparty_end_date,
        requester_publish_status, counterparty_publish_status,
        requester_assignment_kind, counterparty_assignment_kind,
        source_key)
       VALUES
       ($1, $2, $3, $4, $5, $6, '2049-06-14', '2049-06-15', $7, $8, 0, 0,
        '2049-06-14', '2049-06-14', '2049-06-15', '2049-06-15',
        'published', 'published', 'regular', 'regular', $9)`,
      [swapRequestId, orgId, `${orgId}-a`, `${orgId}-b`, assignmentA, assignmentB, shiftA, shiftB, `w3evidence:${randomUUID()}`],
    )

    // Cancelled dispatch snapshot referencing shiftA (via the API).
    await seedDispatchFlow(requesterToken, orgId)
    const scheduleGroupId = await seedScheduleGroup(orgId)
    const dispatch = await postJson('/api/attendance/schedule-dispatch-requests', requesterToken, orgId, {
      userId: `${orgId}-a`,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftA,
      startDate: '2049-06-10',
      endDate: '2049-06-10',
    })
    expect(dispatch.status, dispatch.raw).toBe(201)
    const dispatchRequestId = dispatch.body.data.request.id as string
    const cancel = await postJson(`/api/attendance/schedule-dispatch-requests/${dispatchRequestId}/cancel`, requesterToken, orgId, {})
    expect(cancel.status, cancel.raw).toBe(200)

    // Neither the rejected swap snapshot nor the cancelled dispatch snapshot blocks.
    const del = await requestJson(`${baseUrl}/api/attendance/shifts/${shiftA}`, {
      method: 'DELETE',
      headers: authHeaders(requesterToken, orgId),
    })
    expect(del.status, del.raw).toBe(200)

    // Evidence rows remain stored untouched (the dispatch FK is ON DELETE SET NULL:
    // the row stays, only the unresolvable pointer is cleared).
    const evidence = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM attendance_shift_swap_requests WHERE org_id = $1) AS swaps,
         (SELECT COUNT(*)::int FROM attendance_schedule_dispatch_requests WHERE org_id = $1) AS dispatches`,
      [orgId],
    )
    expect(evidence.rows[0]).toMatchObject({ swaps: 1, dispatches: 1 })

    // Reads redact the unresolvable raw UUID behind a neutral label.
    const swapList = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests`, { headers: authHeaders(requesterToken, orgId) })
    expect(swapList.status, swapList.raw).toBe(200)
    const swapItem = swapList.body.data.items.find((item: any) => item.requestId === swapRequestId)
    expect(swapItem.requesterShiftId).toBeNull()
    expect(swapItem.requester_shift_id).toBeNull()
    expect(swapItem.requesterShiftLabel).toBe(DELETED_LABEL)
    expect(swapItem.requesterShiftStatus).toBe('deleted')
    expect(swapItem.counterpartyShiftLabel).toBe('Ev B')
    expect(swapItem.counterpartyShiftStatus).toBe('available')

    const swapDetail = await requestJson(`${baseUrl}/api/attendance/shift-swap-requests/${swapRequestId}`, { headers: authHeaders(requesterToken, orgId) })
    expect(swapDetail.status, swapDetail.raw).toBe(200)
    expect(swapDetail.body.data.shiftSwap.requesterShiftId).toBeNull()
    expect(swapDetail.body.data.shiftSwap.requesterShiftLabel).toBe(DELETED_LABEL)

    const dispatchDetail = await requestJson(`${baseUrl}/api/attendance/schedule-dispatch-requests/${dispatchRequestId}`, { headers: authHeaders(requesterToken, orgId) })
    expect(dispatchDetail.status, dispatchDetail.raw).toBe(200)
    expect(dispatchDetail.body.data.scheduleDispatch.targetShiftId).toBeNull()
    expect(dispatchDetail.body.data.scheduleDispatch.targetShiftLabel).toBe(DELETED_LABEL)
    expect(dispatchDetail.body.data.scheduleDispatch.targetShiftStatus).toBe('deleted')

    const requestList = await requestJson(
      `${baseUrl}/api/attendance/requests?from=2049-06-10&to=2049-06-10`,
      { headers: authHeaders(requesterToken, orgId) },
    )
    expect(requestList.status, requestList.raw).toBe(200)
    const requestItem = requestList.body.data.items.find((item: any) => item.id === dispatchRequestId)
    expect(requestItem.metadata.scheduleDispatch.targetShiftId).toBeNull()
    expect(requestItem.metadata.scheduleDispatch.targetShiftLabel).toBe(DELETED_LABEL)
    expect(requestItem.metadata.scheduleDispatch.targetShiftStatus).toBe('deleted')

    const requestDetail = await requestJson(
      `${baseUrl}/api/attendance/requests/${dispatchRequestId}`,
      { headers: authHeaders(requesterToken, orgId) },
    )
    expect(requestDetail.status, requestDetail.raw).toBe(200)
    expect(requestDetail.body.data.request.metadata.scheduleDispatch.targetShiftId).toBeNull()
    expect(requestDetail.body.data.request.metadata.scheduleDispatch.targetShiftLabel).toBe(DELETED_LABEL)
    expect(requestDetail.body.data.request.metadata.scheduleDispatch.targetShiftStatus).toBe('deleted')

    const crossOrgRequestDetail = await requestJson(
      `${baseUrl}/api/attendance/requests/${dispatchRequestId}`,
      { headers: authHeaders(requesterToken, org('delete-evidence-other')) },
    )
    expect(crossOrgRequestDetail.status, crossOrgRequestDetail.raw).toBe(404)

    // The raw UUID of the deleted shift must appear NOWHERE in these read payloads.
    expect(swapList.raw).not.toContain(shiftA)
    expect(swapDetail.raw).not.toContain(shiftA)
    expect(dispatchDetail.raw).not.toContain(shiftA)
    expect(requestList.raw).not.toContain(shiftA)
    expect(requestDetail.raw).not.toContain(shiftA)
  })

  it('read hardening: an orphaned schedule-dispatch request never trusts or exposes a metadata-only shift UUID', async () => {
    const orgId = org('orphan-dispatch')
    const userId = `${orgId}-user`
    const token = await mintToken(userId)
    const orphanRequestId = randomUUID()
    const rawShiftId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_requests
         (id, user_id, org_id, work_date, request_type, reason, status, metadata)
       VALUES
         ($1, $2, $3, '2049-06-20', 'schedule_dispatch', 'orphan evidence', 'cancelled', $4::jsonb)`,
      [
        orphanRequestId,
        userId,
        orgId,
        JSON.stringify({ scheduleDispatch: { targetShiftId: rawShiftId } }),
      ],
    )

    const list = await requestJson(
      `${baseUrl}/api/attendance/requests?from=2049-06-20&to=2049-06-20`,
      { headers: authHeaders(token, orgId) },
    )
    expect(list.status, list.raw).toBe(200)
    const item = list.body.data.items.find((row: any) => row.id === orphanRequestId)
    expect(item.metadata.scheduleDispatch).toMatchObject({
      targetShiftId: null,
      targetShiftLabel: DELETED_LABEL,
      targetShiftStatus: 'deleted',
    })
    expect(list.raw).not.toContain(rawShiftId)

    const detail = await requestJson(
      `${baseUrl}/api/attendance/requests/${orphanRequestId}`,
      { headers: authHeaders(token, orgId) },
    )
    expect(detail.status, detail.raw).toBe(200)
    expect(detail.body.data.request.metadata.scheduleDispatch).toMatchObject({
      targetShiftId: null,
      targetShiftLabel: DELETED_LABEL,
      targetShiftStatus: 'deleted',
    })
    expect(detail.raw).not.toContain(rawShiftId)
  })

  it('concurrency: a reference insert racing a delete is serialized by the shared lock protocol', async () => {
    const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
    const service = plugin.__attendanceShiftServiceForTests.getService()
    const orgId = org('concurrency')
    const token = await mintToken(`${orgId}-admin`)
    const shiftId = (await createShiftViaApi(token, orgId, { name: 'Race', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string

    const wrap = (client: import('pg').PoolClient) => ({
      query: async (text: string, params?: unknown[]) => (await client.query(text, params as never[])).rows,
      transaction: async (cb: (trx: { query: (text: string, params?: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) => {
        await client.query('BEGIN')
        try {
          const result = await cb({ query: async (text: string, params?: unknown[]) => (await client.query(text, params as never[])).rows })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        }
      },
    })

    async function waitUntilBlockedBy(blockedPid: number, blockerPid: number) {
      const deadline = Date.now() + 10000
      for (;;) {
        const r = await pool.query('SELECT pg_blocking_pids($1)::int[] AS blockers', [blockedPid])
        if ((r.rows[0]?.blockers ?? []).includes(blockerPid)) return
        if (Date.now() > deadline) throw new Error(`pid ${blockedPid} never blocked by ${blockerPid} (vacuous concurrency proof)`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    // Leg A: writer first. W locks the shift FOR SHARE and inserts the reference
    // uncommitted; the canonical delete must block, then fail 409 with zero writes.
    const clientW = await pool.connect()
    const clientD = await pool.connect()
    try {
      const pidW = (await clientW.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pidD = (await clientD.query('SELECT pg_backend_pid() AS pid')).rows[0].pid

      await clientW.query('BEGIN')
      const trxW = { query: async (text: string, params?: unknown[]) => (await clientW.query(text, params as never[])).rows }
      await service.assertShiftReferenceAllowed(trxW, { orgId, shiftId, producer: 'concurrency_test' })
      await clientW.query(
        `INSERT INTO attendance_shift_assignments
         (id, org_id, user_id, shift_id, slot_index, start_date, end_date, is_active)
         VALUES ($1, $2, $3, $4, 0, '2049-06-10', '2049-06-10', true)`,
        [randomUUID(), orgId, `${orgId}-racer`, shiftId],
      )

      let deleteOutcome: { error?: any } = {}
      const deletePromise = service.deleteShift(wrap(clientD), { orgId, shiftId })
        .then(() => { deleteOutcome = {} })
        .catch((error: unknown) => { deleteOutcome = { error } })
      await waitUntilBlockedBy(pidD, pidW)
      await clientW.query('COMMIT')
      await deletePromise

      expect(deleteOutcome.error).toBeTruthy()
      expect(deleteOutcome.error.status).toBe(409)
      expect(deleteOutcome.error.code).toBe(DELETE_BLOCKED_CODE)
      const stillThere = await pool.query('SELECT 1 FROM attendance_shifts WHERE id = $1', [shiftId])
      expect(stillThere.rows).toHaveLength(1)
    } finally {
      await clientW.query('ROLLBACK').catch(() => undefined)
      await clientD.query('ROLLBACK').catch(() => undefined)
      clientW.release()
      clientD.release()
    }

    // Leg B: delete first. D locks FOR UPDATE and deletes uncommitted; the guard
    // must block, then fail 404 — the reference can never land on a deleted shift.
    const shiftB = (await createShiftViaApi(token, orgId, { name: 'Race B', workStartTime: '09:00', workEndTime: '18:00' })).body.data.id as string
    const clientD2 = await pool.connect()
    const clientW2 = await pool.connect()
    try {
      const pidD2 = (await clientD2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const pidW2 = (await clientW2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid

      await clientD2.query('BEGIN')
      // Same lock acquisition order as the canonical delete (FOR UPDATE on the parent row).
      await clientD2.query('SELECT id, name FROM attendance_shifts WHERE id = $1 AND org_id = $2 FOR UPDATE', [shiftB, orgId])
      await clientD2.query('DELETE FROM attendance_shift_segments WHERE org_id = $1 AND shift_id = $2', [orgId, shiftB])
      await clientD2.query('DELETE FROM attendance_shifts WHERE id = $1 AND org_id = $2', [shiftB, orgId])

      let guardOutcome: { error?: any } = {}
      const trxW2 = { query: async (text: string, params?: unknown[]) => (await clientW2.query(text, params as never[])).rows }
      await clientW2.query('BEGIN')
      const guardPromise = service.assertShiftReferenceAllowed(trxW2, { orgId, shiftId: shiftB, producer: 'concurrency_test' })
        .then(() => { guardOutcome = {} })
        .catch((error: unknown) => { guardOutcome = { error } })
      await waitUntilBlockedBy(pidW2, pidD2)
      await clientD2.query('COMMIT')
      await guardPromise

      expect(guardOutcome.error).toBeTruthy()
      expect(guardOutcome.error.status).toBe(404)
      expect(guardOutcome.error.code).toBe('NOT_FOUND')
    } finally {
      await clientD2.query('ROLLBACK').catch(() => undefined)
      await clientW2.query('ROLLBACK').catch(() => undefined)
      clientD2.release()
      clientW2.release()
    }
  })
})
