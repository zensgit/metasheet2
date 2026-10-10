import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import { restoreAttendanceSettingsRow, snapshotAttendanceSettingsRow } from '../utils/attendance-settings-row'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
if (!dbUrl) throw new Error('LIVE_PUNCH_ORDER_REQUIRES_DATABASE_URL')
const orgId = `punch_order_${randomUUID().replace(/-/g, '')}`
const userIds: string[] = []
const shiftIds: string[] = []
const day = '2026-08-19'

type Punch = { eventType: 'check_in' | 'check_out'; occurredAt: string; timezone?: string }
type WireResponse = { ok: boolean; data?: Record<string, unknown>; token?: string; error?: { code: string; message: string } }

describe('live punch order and original event evidence (real HTTP and PostgreSQL)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  const previousEnv = { DATABASE_URL: process.env.DATABASE_URL, SKIP_PLUGINS: process.env.SKIP_PLUGINS }

  async function request(route: string, token?: string, body?: Record<string, unknown>, method = 'POST') {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json() as WireResponse }
  }

  async function user() {
    const id = randomUUID()
    userIds.push(id)
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'punch order fixture', 'fixture', 'user', '[]'::jsonb, true, false)`,
      [id, `${id}@punch-order.test`],
    )
    await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [id, orgId])
    const minted = await request(`/api/auth/dev-token?userId=${id}&tenantId=${orgId}&roles=admin&perms=attendance:read,attendance:write,attendance:admin`, undefined, undefined, 'GET')
    expect(minted.status).toBe(200)
    const token = minted.body.token
    if (!token) throw new Error('LIVE_PUNCH_ORDER_TOKEN_MISSING')
    return { id, token }
  }

  const punch = (token: string, input: Punch) => request('/api/attendance/punch', token, { orgId, timezone: 'Asia/Shanghai', ...input })

  async function stored(id: string) {
    const events = await pool.query(
      `SELECT id, work_date::text, event_type, occurred_at, timezone, source, meta
       FROM attendance_events WHERE org_id = $1 AND user_id = $2 ORDER BY occurred_at, id`,
      [orgId, id],
    )
    const records = await pool.query(
      `SELECT work_date::text, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status
       FROM attendance_records WHERE org_id = $1 AND user_id = $2 ORDER BY work_date`,
      [orgId, id],
    )
    return { events: events.rows, records: records.rows }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = dbUrl
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const { MetaSheetServer: Server } = await import('../../src/index')
    server = new Server({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins/plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('LIVE_PUNCH_ORDER_HTTP_UNAVAILABLE')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
    const admin = await user()
    const configured = await request('/api/attendance/rules/default', admin.token, {
      orgId, timezone: 'Asia/Shanghai', workStartTime: '09:00', workEndTime: '18:00',
      lateGraceMinutes: 10, earlyGraceMinutes: 10, roundingMinutes: 5, workingDays: [0, 1, 2, 3, 4, 5, 6],
    }, 'PUT')
    expect(configured.status).toBe(200)
  }, 180_000)

  afterAll(async () => {
    await server?.stop()
    if (pool) {
      await pool.query('DELETE FROM attendance_events WHERE org_id = $1', [orgId])
      await pool.query('DELETE FROM attendance_records WHERE org_id = $1', [orgId])
      await pool.query('DELETE FROM attendance_shift_assignments WHERE org_id = $1', [orgId])
      await pool.query('DELETE FROM attendance_shifts WHERE org_id = $1 AND id = ANY($2::uuid[])', [orgId, shiftIds])
      await pool.query('DELETE FROM attendance_rules WHERE org_id = $1', [orgId])
      await pool.query('DELETE FROM user_orgs WHERE org_id = $1', [orgId])
      await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds])
      await pool.end()
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }, 60_000)

  it.each(['Asia/Shanghai', 'Asia/Taipei'])('keeps an early-in / late-out day in %s together with original instants and polarity', async (timezone) => {
    const actor = await user()
    const inputs: Punch[] = [
      { eventType: 'check_in', occurredAt: `${day}T08:55:00+08:00`, timezone },
      { eventType: 'check_out', occurredAt: `${day}T18:05:00+08:00`, timezone },
    ]
    for (const input of inputs) expect((await punch(actor.token, input)).status).toBe(200)
    const result = await stored(actor.id)
    expect(result.events.map(({ work_date, event_type, occurred_at }) => ({ work_date, event_type, occurred_at }))).toEqual(
      inputs.map(input => ({ work_date: day, event_type: input.eventType, occurred_at: new Date(input.occurredAt) })),
    )
    expect(result.records).toEqual([{
      work_date: day, first_in_at: new Date(inputs[0].occurredAt), last_out_at: new Date(inputs[1].occurredAt),
      work_minutes: 550, late_minutes: 0, early_leave_minutes: 0, status: 'normal',
    }])
    expect(await stored(actor.id)).toEqual(result)
  })

  it.each(['check_in', 'check_out'] as const)('rolls back a reversed %s without changing existing raw evidence or projection', async (firstType) => {
    const actor = await user()
    const first: Punch = { eventType: firstType, occurredAt: `${day}T${firstType === 'check_in' ? '10' : '09'}:00:00+08:00` }
    expect((await punch(actor.token, first)).status).toBe(200)
    const before = await stored(actor.id)
    const rejected = await punch(actor.token, {
      eventType: firstType === 'check_in' ? 'check_out' : 'check_in',
      occurredAt: `${day}T${firstType === 'check_in' ? '09' : '10'}:00:00+08:00`,
    })
    expect(rejected).toEqual({ status: 409, body: { ok: false, error: {
      code: 'ATTENDANCE_PUNCH_ORDER_CONFLICT',
      message: 'Check-out cannot precede check-in; review the work date and existing punches',
    } } })
    expect(await stored(actor.id)).toEqual(before)
  })

  it('retains accepted repeated punches while keeping earliest in and latest out', async () => {
    const actor = await user()
    const inputs: Punch[] = [
      { eventType: 'check_in', occurredAt: `${day}T09:00:00+08:00` },
      { eventType: 'check_in', occurredAt: `${day}T10:00:00+08:00` },
      { eventType: 'check_out', occurredAt: `${day}T17:00:00+08:00` },
      { eventType: 'check_out', occurredAt: `${day}T18:00:00+08:00` },
    ]
    for (const input of inputs) expect((await punch(actor.token, input)).status).toBe(200)
    const result = await stored(actor.id)
    expect(result.events.map(({ event_type, occurred_at }) => ({ event_type, occurred_at }))).toEqual(
      inputs.map(input => ({ event_type: input.eventType, occurred_at: new Date(input.occurredAt) })),
    )
    expect(result.records).toEqual([{
      work_date: day, first_in_at: new Date(inputs[0].occurredAt), last_out_at: new Date(inputs[3].occurredAt),
      work_minutes: 540, late_minutes: 0, early_leave_minutes: 0, status: 'normal',
    }])
  })

  it('keeps a published overnight pair on the starting work date without rewriting its events', async () => {
    const actor = await user()
    const shift = await request('/api/attendance/shifts', actor.token, {
      orgId, name: 'punch chronology night', timezone: 'Asia/Shanghai', start_time: '22:00', end_time: '06:00',
      is_overnight: true, late_grace_minutes: 10, early_grace_minutes: 10, rounding_minutes: 5, working_days: [0, 1, 2, 3, 4, 5, 6],
    })
    expect(shift.status).toBe(201)
    const shiftId = String(shift.body.data?.id)
    shiftIds.push(shiftId)
    expect((await request('/api/attendance/assignments', actor.token, { orgId, userId: actor.id, shiftId, startDate: day, isActive: true })).status).toBe(201)
    const inputs: Punch[] = [
      { eventType: 'check_in', occurredAt: `${day}T22:05:00+08:00` },
      { eventType: 'check_out', occurredAt: '2026-08-20T05:55:00+08:00' },
    ]
    for (const input of inputs) expect((await punch(actor.token, input)).status).toBe(200)
    const result = await stored(actor.id)
    expect(result.events.map(({ work_date, event_type, occurred_at }) => ({ work_date, event_type, occurred_at }))).toEqual(
      inputs.map(input => ({ work_date: day, event_type: input.eventType, occurred_at: new Date(input.occurredAt) })),
    )
    expect(result.records).toEqual([{
      work_date: day, first_in_at: new Date(inputs[0].occurredAt), last_out_at: new Date(inputs[1].occurredAt),
      work_minutes: 470, late_minutes: 0, early_leave_minutes: 0, status: 'normal',
    }])
  })

  it('also rolls back an order reversal introduced by the final in/out merge policy', async () => {
    const actor = await user()
    expect((await punch(actor.token, { eventType: 'check_in', occurredAt: `${day}T09:00:00+08:00` })).status).toBe(200)
    expect((await punch(actor.token, { eventType: 'check_out', occurredAt: `${day}T10:00:00+08:00` })).status).toBe(200)
    // Model an already-approved outdoor in without invoking the unrelated approval flow.
    await pool.query(
      "UPDATE attendance_events SET source = 'outdoor_approval' WHERE org_id = $1 AND user_id = $2 AND event_type = 'check_in'",
      [orgId, actor.id],
    )
    const settings = await snapshotAttendanceSettingsRow(pool)
    try {
      expect((await request('/api/attendance/settings', actor.token, {
        punchPolicy: { merge: { internalWinsOnIn: true, externalWinsOnOut: true } },
      }, 'PUT')).status).toBe(200)
      const before = await stored(actor.id)
      // Append alone retains 09:00 -> 10:00, but internalWinsOnIn chooses 11:00.
      const rejected = await punch(actor.token, { eventType: 'check_in', occurredAt: `${day}T11:00:00+08:00` })
      expect(rejected).toEqual({ status: 409, body: { ok: false, error: {
        code: 'ATTENDANCE_PUNCH_ORDER_CONFLICT',
        message: 'Check-out cannot precede check-in; review the work date and existing punches',
      } } })
      expect(await stored(actor.id)).toEqual(before)
    } finally {
      await restoreAttendanceSettingsRow(pool, settings)
      require('../../../../plugins/plugin-attendance/index.cjs').resetAttendanceSettingsCacheForTests()
    }
  })
})
