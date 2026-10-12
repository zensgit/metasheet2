import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createOnlinePunchDbFixture, punchClock } from '../utils/attendance-online-punch-db'
if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('ATTENDANCE_TIMEZONE_READ_CONTEXT_REAL_DATABASE_REQUIRED')
const require = createRequire(import.meta.url)
const { setBusinessTripInstantForTests } = require('../../../../plugins/plugin-attendance/lib/attendance-business-trip.cjs')
const live = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
const epoch = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
const day = (offset = 0) => new Date(epoch + offset * 86400000).toISOString().slice(0, 10)
const instant = (offset = 0, hour = 0) => new Date(epoch + offset * 86400000 + hour * 3600000).toISOString()
describe('readonly current, target-date calendar and stored export actual HTTP/PG', () => {
  let admin: Awaited<ReturnType<typeof live.user>>
  let employee: Awaited<ReturnType<typeof live.user>>
  let authRoleStatements = 0
  let existingAuditStatements = 0
  async function readWithoutBusinessDml<T>(work: () => Promise<T>): Promise<T> {
    const clientPrototype = require('pg').Client.prototype as { query: (...args: unknown[]) => unknown }
    const original = clientPrototype.query
    const writes: string[] = []
    clientPrototype.query = function (this: unknown, ...args: unknown[]) {
      const arg = args[0] as string | { text?: string }
      const sql = typeof arg === 'string' ? arg : arg?.text || ''
      const verb = sql.trimStart().split(/\s+/, 1)[0].toUpperCase()
      if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP'].includes(verb)) {
        // Existing RBAC role materialization attempts are outside attendance
        // read semantics. Exempt only the exact assignUserRoles statement;
        // pg-pool defers the client call and does not retain the caller's stack.
        const normalized = sql.trim().replace(/\s+/g, ' ')
        const roleMaterialization = normalized === 'INSERT INTO user_roles (user_id, role_id) SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING RETURNING user_id'
        const existingAttendanceAudit = normalized === 'INSERT INTO operation_audit_logs ( actor_id, actor_type, action, resource_type, resource_id, request_id, ip, user_agent, route, status_code, latency_ms, meta, occurred_at, created_at ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb, now(), now())'
        if (roleMaterialization) authRoleStatements += 1
        else if (existingAttendanceAudit) existingAuditStatements += 1
        else writes.push(verb + ':' + (sql.match(/(?:INTO|UPDATE|FROM|TABLE)\s+([a-zA-Z_][a-zA-Z_0-9]*)/i)?.[1] ?? 'unknown'))
      }
      return Reflect.apply(original, this, args)
    }
    let result: T
    try { result = await work() } finally { clientPrototype.query = original }
    expect(writes).toEqual([])
    return result
  }
  const get = (route: string, token = employee.token) => readWithoutBusinessDml(() => live.request(route, token, undefined, 'GET'))
  const calendar = (from: string, to = from, userId = employee.userId) =>
    '/api/attendance/effective-calendar?userId=' + userId + '&from=' + from + '&to=' + to
  async function assertCalendarTargetParity(response: Awaited<ReturnType<typeof get>>, token: string) {
    for (const item of response.body.data.items) {
      const single = await get('/api/attendance/timezone-context/me?workDate=' + item.date, token)
      expect(single.status, single.body.error?.code).toBe(200)
      const target = single.body.data
      expect(item.attendanceTimeContext).toEqual({
        targetWorkDate: target.workDate, effectiveTimezone: target.timezone,
        timezoneSource: target.provenance?.source ?? 'legacy_record',
        mode: target.provenance?.mode ?? null, policyVersion: target.provenance?.policyVersion ?? null,
        contextFingerprint: target.contextFingerprint, frozen: target.frozen,
      })
      expect(item.effective.isWorkingDay).toBe(target.isWorkingDay)
    }
  }
  async function state() {
    return (await live.pool.query(`SELECT
      (SELECT count(*)::int FROM attendance_events WHERE org_id=$1) AS events,
      (SELECT count(*)::int FROM attendance_records WHERE org_id=$1) AS records,
      (SELECT count(*)::int FROM attendance_requests WHERE org_id=$1) AS requests,
      (SELECT count(*)::int FROM attendance_timezone_policies WHERE org_id=$1) AS policies,
      (SELECT count(*)::int FROM attendance_timezone_policy_audit WHERE org_id=$1) AS audit,
      (SELECT count(*)::int FROM attendance_timezone_context_companions WHERE org_id=$1) AS companions`, [live.orgId])).rows
  }
  beforeAll(async () => {
    punchClock.setOnlinePunchInstantForTests(instant(0, 0.5))
    admin = await live.start(); employee = await live.user(false)
  }, 180000)
  beforeEach(() => punchClock.setOnlinePunchInstantForTests(instant(0, 0.5)))
  afterAll(async () => { console.info('readonly-existing-infrastructure-statements', { authRoleStatements, existingAuditStatements }); setBusinessTripInstantForTests(null); await live.stop() }, 60000)

  it('separates server current instant from the unchanged asOf scheduling date, OFF', async () => {
    const before = await state()
    const response = await get('/api/attendance/rules/me?asOf=' + day(2))
    expect(response.status, response.body.error?.code).toBe(200)
    const rule = (await live.pool.query('SELECT id,timezone_version FROM attendance_rules WHERE org_id=$1 AND is_default=true', [live.orgId])).rows[0]
    expect(response.body.data.resolvedForDate).toBe(day(2))
    expect(response.body.data.resolvedAt).toBe(response.body.data.attendanceTimeContext.resolvedForInstant)
    expect(response.body.data.runtimeRule.source).toBe('rule')
    expect(response.body.data.attendanceTimeContext).toEqual({
      resolvedForInstant: instant(0, 0.5), effectiveTimezone: 'UTC', timezoneSource: 'system_default',
      mode: 'default_only', policyVersion: 0, referenceId: rule.id, version: rule.timezone_version,
      currentLocalDate: day(), nextEffectiveBoundary: null,
    })
    expect(await state()).toEqual(before)
  })
  it('reads enabled employee UTC intervals with exact end and next-boundary semantics', async () => {
    await live.pool.query('INSERT INTO attendance_timezone_policies(org_id,enabled,updated_by) VALUES($1,true,$2)', [live.orgId, admin.userId])
    await live.pool.query(`INSERT INTO attendance_employee_timezone_overrides
      (org_id,user_id,timezone,effective_from,effective_to,created_by,updated_by)
      VALUES($1,$2,'Asia/Singapore',$3,$4,$5,$5)`, [live.orgId, employee.userId, instant(-3), instant(3), admin.userId])
    const before = await state()
    const response = await get('/api/attendance/rules/me?asOf=' + day(1))
    expect(response.status, response.body.error?.code).toBe(200)
    expect(response.body.data.attendanceTimeContext).toMatchObject({
      effectiveTimezone: 'Asia/Singapore', timezoneSource: 'employee_override', mode: 'multi_timezone',
      policyVersion: 1, currentLocalDate: day(), nextEffectiveBoundary: instant(3),
    })
    expect(response.body.data.runtimeRule.timezone).toBe('Asia/Singapore')
    punchClock.setOnlinePunchInstantForTests(instant(3))
    const ended = await get('/api/attendance/rules/me?asOf=' + day(4))
    expect(ended.status, ended.body.error?.code).toBe(200)
    expect(ended.body.data.attendanceTimeContext).toMatchObject({ effectiveTimezone: 'UTC', timezoneSource: 'system_default' })
    expect(await state()).toEqual(before)
  })
  it('calendar preserves a single zone and provides each authoritative date fingerprint', async () => {
    const before = await state()
    const response = await get(calendar(day(), day(1)))
    expect(response.status, response.body.error?.code).toBe(200)
    expect(response.body.data.timezone).toBe('Asia/Singapore')
    expect(response.body.data.timezoneMode).toBe('single')
    expect(response.body.data.items.map((item: { date: string, attendanceTimeContext: unknown }) => ({
      date: item.date, context: item.attendanceTimeContext,
    }))).toEqual([0, 1].map(offset => ({ date: day(offset), context: {
      targetWorkDate: day(offset), effectiveTimezone: 'Asia/Singapore', timezoneSource: 'employee_override',
      mode: 'multi_timezone', policyVersion: 1, contextFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), frozen: false,
    } })))
    await assertCalendarTargetParity(response, employee.token)
    expect(await state()).toEqual(before)
  })
  it('pending trip is inert; final approval changes only its own calendar days/current instant', async () => {
    const subject = await live.user()
    const flow = await live.request('/api/attendance/approval-flows', admin.token, { orgId: live.orgId, name: 'read context synthetic trip',
      requestType: 'business_trip', steps: [{ approverUserIds: [admin.userId] }] })
    expect(flow.status).toBe(201)
    setBusinessTripInstantForTests(instant())
    const created = await live.request('/api/attendance/business-trip-requests', subject.token, {
      destinationTimezone: 'Asia/Tokyo', startAt: instant(5), endAt: instant(6, 18), approvalFlowId: flow.body.data.id,
    })
    expect(created.status, created.body.error?.code).toBe(201)
    punchClock.setOnlinePunchInstantForTests(instant(5, 0.5))
    const pending = await get('/api/attendance/rules/me?asOf=' + day(5), subject.token)
    expect(pending.status, pending.body.error?.code).toBe(200)
    expect(pending.body.data.attendanceTimeContext.timezoneSource).toBe('system_default')
    punchClock.setOnlinePunchInstantForTests(instant())
    const approved = await live.request('/api/attendance/requests/' + created.body.data.request.id + '/approve', admin.token, {})
    expect(approved.status, approved.body.error?.code).toBe(200)
    const before = await state()
    punchClock.setOnlinePunchInstantForTests(instant(5, 0.5))
    const current = await get('/api/attendance/rules/me?asOf=' + day(4), subject.token)
    expect(current.status, current.body.error?.code).toBe(200)
    expect(current.body.data.resolvedForDate).toBe(day(4))
    expect(current.body.data.runtimeRule.timezone).toBe('UTC')
    expect(current.body.data.attendanceTimeContext).toMatchObject({
      effectiveTimezone: 'Asia/Tokyo', timezoneSource: 'trip', nextEffectiveBoundary: instant(6, 18),
    })
    const response = await get(calendar(day(4), day(7), subject.userId), subject.token)
    expect(response.status, response.body.error?.code).toBe(200)
    expect({ timezone: response.body.data.timezone, mode: response.body.data.timezoneMode }).toEqual({ timezone: null, mode: 'per_day' })
    expect(response.body.data.items.map((item: { attendanceTimeContext: { effectiveTimezone: string } }) => item.attendanceTimeContext.effectiveTimezone))
      .toEqual(['UTC', 'Asia/Tokyo', 'Asia/Tokyo', 'UTC'])
    await assertCalendarTargetParity(response, subject.token)
    expect(await state()).toEqual(before)
  })
  it('stored legacy history and JSON export retain their source zone after current policy changes', async () => {
    const subject = await live.user()
    const id = randomUUID()
    await live.pool.query(`INSERT INTO attendance_records(id,org_id,user_id,work_date,timezone,first_in_at,last_out_at,status,is_workday,work_minutes)
      VALUES($1,$2,$3,$4,'America/New_York',$5,$6,'normal',true,480)`,
    [id, live.orgId, subject.userId, day(-2), instant(-2, 14), instant(-2, 22)])
    const before = await state()
    const record = await get('/api/attendance/records?from=' + day(-2) + '&to=' + day(-2), subject.token)
    expect(record.status, record.body.error?.code).toBe(200)
    expect(record.body.data.items[0].attendanceTimeContext).toEqual({
      effectiveTimezone: 'America/New_York', timezoneSource: 'legacy_record', mode: null, policyVersion: null,
      contextFingerprint: null, frozen: true, targetWorkDate: day(-2),
    })
    expect(record.body.data.items[0].workday_context).toMatchObject({
      timezone: 'America/New_York', resolvedIsWorkday: null, matchesStored: null, workingDays: null,
    })
    const historyCalendar = await get(calendar(day(-2), day(-2), subject.userId), subject.token)
    expect(historyCalendar.status, historyCalendar.body.error?.code).toBe(200)
    expect(historyCalendar.body.data.items[0].attendanceTimeContext).toEqual(record.body.data.items[0].attendanceTimeContext)
    expect(historyCalendar.body.data.items[0].effective).toEqual({ isWorkingDay: true, source: 'stored_record' })
    // Observe the owned fixture's actual URL only; every request still reaches
    // the real HTTP server. No response interception or synthetic HTTP data.
    const originalFetch = globalThis.fetch
    let exportUrl = ''
    globalThis.fetch = async (input, init) => {
      if (typeof input === 'string' && input.includes('/api/attendance/export?')) exportUrl = input
      return originalFetch(input, init)
    }
    let exported: Awaited<ReturnType<typeof get>>
    try { exported = await get('/api/attendance/export?format=json&from=' + day(-2) + '&to=' + day(-2), subject.token) }
    finally { globalThis.fetch = originalFetch }
    expect(exported.status, exported.body.error?.code).toBe(200)
    const csv = await readWithoutBusinessDml(() => originalFetch(exportUrl.replace('format=json', 'format=csv&header=code'), {
      headers: { Authorization: 'Bearer ' + subject.token },
    }))
    expect(csv.status).toBe(200)
    const raw = await csv.text()
    const lines = raw.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    const headers = lines[0].split(',')
    const values = lines[1].split(',')
    const identity = Object.fromEntries(headers.map((key, index) => [key, values[index]]))
    expect(identity).toMatchObject({
      work_date: day(-2), first_in_at: instant(-2, 14), last_out_at: instant(-2, 22),
      timezone: 'America/New_York', timezone_source: 'legacy_record',
    })
    expect(exported.body.data.items[0]).toMatchObject({
      timezone: 'America/New_York', timezone_source: 'legacy_record', work_date: day(-2),
      first_in_at: instant(-2, 14), last_out_at: instant(-2, 22),
    })
    expect(exported.body.data.reportFields.map((field: { exportKey?: string, code: string }) => field.exportKey || field.code))
      .toEqual(expect.arrayContaining(['timezone', 'timezone_source', 'work_date', 'first_in_at', 'last_out_at']))
    expect(await state()).toEqual(before)
  })
  it('rejects a foreign calendar subject even for an administrator, zero DML', async () => {
    const foreign = await live.user()
    await live.pool.query('UPDATE user_orgs SET org_id=$1 WHERE user_id=$2 AND org_id=$3', [randomUUID(), foreign.userId, live.orgId])
    const before = await state()
    const response = await get(calendar(day(), day(), foreign.userId), admin.token)
    expect(response).toMatchObject({ status: 403, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED' } } })
    expect(await state()).toEqual(before)
  })
  it('uses governance DATE boundaries and refuses two valid current-date contexts', async () => {
    const subject = await live.user()
    const groupId = randomUUID()
    await live.pool.query('INSERT INTO attendance_groups(id,org_id,name,timezone) VALUES($1::uuid,$2,$1::text,\'Asia/Tokyo\')', [groupId, live.orgId])
    await live.pool.query(`INSERT INTO attendance_calculation_group_memberships
      (org_id,user_id,group_id,effective_from,assigned_by,assigned_reason,assigned_correlation_id)
      VALUES($1,$2,$3,$4,$5,'synthetic read test',$6)`,
    [live.orgId, subject.userId, groupId, day(1), admin.userId, randomUUID()])
    const before = await state()
    const initial = await get('/api/attendance/rules/me', subject.token)
    expect(initial.status, initial.body.error?.code).toBe(200)
    expect(initial.body.data.attendanceTimeContext.nextEffectiveBoundary).toBe(instant(0, 15))
    const ranged = await get(calendar(day(), day(2), subject.userId), subject.token)
    expect(ranged.status, ranged.body.error?.code).toBe(200)
    expect(ranged.body.data.items.map((item: { attendanceTimeContext: { effectiveTimezone: string } }) =>
      item.attendanceTimeContext.effectiveTimezone)).toEqual(['UTC', 'Asia/Tokyo', 'Asia/Tokyo'])
    await assertCalendarTargetParity(ranged, subject.token)
    punchClock.setOnlinePunchInstantForTests(instant(0, 23.5))
    const ambiguous = await get('/api/attendance/rules/me', subject.token)
    expect(ambiguous.status).toBe(409)
    expect(ambiguous.body.error.code).toBe('ATTENDANCE_TIMEZONE_CURRENT_CONTEXT_CONFLICT')
    expect(await state()).toEqual(before)
  })
  it('new frozen history retains stored provenance after a later employee override', async () => {
    const subject = await live.user()
    punchClock.setOnlinePunchInstantForTests(instant(-1, 9))
    const punched = await live.request('/api/attendance/punch', subject.token, { orgId: live.orgId, operationId: randomUUID(), eventType: 'check_in' })
    expect(punched.status, punched.body.error?.code).toBe(200)
    await live.pool.query(`INSERT INTO attendance_employee_timezone_overrides
      (org_id,user_id,timezone,effective_from,effective_to,created_by,updated_by)
      VALUES($1,$2,'Asia/Tokyo',$3,NULL,$4,$4)`, [live.orgId, subject.userId, instant(), admin.userId])
    const before = await state()
    const records = await get('/api/attendance/records?from=' + day(-1) + '&to=' + day(-1), subject.token)
    expect(records.status, records.body.error?.code).toBe(200)
    expect(records.body.data.items[0].attendanceTimeContext).toMatchObject({
      effectiveTimezone: 'UTC', timezoneSource: 'system_default', mode: 'multi_timezone',
      policyVersion: 1, frozen: true, contextFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const rules = await get('/api/attendance/rules/me?asOf=' + day(-1), subject.token)
    expect(rules.status, rules.body.error?.code).toBe(200)
    expect(rules.body.data.runtimeRule).toMatchObject({ source: 'rule', timezone: 'UTC' })
    expect(rules.body.data.resolvedAt).toBe(rules.body.data.attendanceTimeContext.resolvedForInstant)
    expect(await state()).toEqual(before)
  })
  it('an actual optional-source SQL failure is a values-free 503, never an OFF fallback', async () => {
    const before = await state()
    await live.pool.query('ALTER TABLE attendance_employee_timezone_overrides RENAME TO attendance_read_test_unavailable_overrides')
    try {
      const response = await get('/api/attendance/rules/me')
      expect(response.status).toBe(503)
      expect(response.body).toEqual({ ok: false, error: {
        code: 'ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE', message: 'ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE',
      } })
    } finally {
      await live.pool.query('ALTER TABLE attendance_read_test_unavailable_overrides RENAME TO attendance_employee_timezone_overrides')
    }
    expect(await state()).toEqual(before)
  })
  it('refuses a revoked self actor despite an issued token', async () => {
    const subject = await live.user(false)
    expect((await get('/api/attendance/rules/me', subject.token)).status).toBe(200)
    await live.pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [subject.userId, live.orgId])
    const before = await state()
    const response = await get('/api/attendance/rules/me', subject.token)
    expect(response.status).toBe(403)
    expect(await state()).toEqual(before)
  })
  it('measures real fresh-calendar SQL for one, seven and thirty-one target dates', async () => {
    const subject = await live.user()
    const clientPrototype = require('pg').Client.prototype as { query: (...args: unknown[]) => unknown }
    const original = clientPrototype.query
    const measurements = []
    for (const days of [1, 7, 31]) {
      const counts: Record<string, number> = { queries: 0 }
      clientPrototype.query = function (this: unknown, ...args: unknown[]) {
        const arg = args[0] as string | { text?: string }
        const sql = typeof arg === 'string' ? arg : arg?.text || ''
        counts.queries += 1
        for (const table of ['attendance_timezone_policies', 'attendance_rules',
          'attendance_employee_timezone_overrides', 'attendance_business_trip_arrangements',
          'attendance_calculation_group_memberships', 'attendance_shift_assignments']) {
          if (sql.includes(table)) counts[table] = (counts[table] || 0) + 1
        }
        return Reflect.apply(original, this, args)
      }
      try {
        const response = await get(calendar(day(40), day(39 + days), subject.userId), subject.token)
        expect(response.status, response.body.error?.code).toBe(200)
        expect(response.body.data.items).toHaveLength(days)
        expect(response.body.data.items.every((item: { attendanceTimeContext?: { contextFingerprint?: string } }) =>
          typeof item.attendanceTimeContext?.contextFingerprint === 'string')).toBe(true)
      } finally { clientPrototype.query = original }
      expect(counts.queries).toBeGreaterThan(0)
      measurements.push({ days, counts })
    }
    // This fixture has the same fixed sources on every requested date. Extending
    // the range must not repeat their SQL once per date.
    for (const { counts } of measurements) {
      for (const table of ['attendance_timezone_policies', 'attendance_employee_timezone_overrides',
        'attendance_business_trip_arrangements', 'attendance_calculation_group_memberships']) {
        expect(counts[table], table).toBe(1)
      }
      expect(counts.attendance_shift_assignments).toBeLessThanOrEqual(2)
      expect(counts.queries).toBeLessThanOrEqual(measurements[0].counts.queries + 5)
    }
    console.info('READ_CONTEXT_SQL_COUNTS ' + JSON.stringify(measurements))
  })

  it('calendar preserves stored absence context even when no first punch exists', async () => {
    const subject = await live.user()
    await live.pool.query(`INSERT INTO attendance_records
      (id,org_id,user_id,work_date,timezone,status,is_workday,work_minutes)
      VALUES($1,$2,$3,$4,'America/New_York','absent',true,0)`,
    [randomUUID(), live.orgId, subject.userId, day(-4)])
    const before = await state()
    const response = await get(calendar(day(-4), day(-4), subject.userId), subject.token)
    expect(response.status, response.body.error?.code).toBe(200)
    expect(response.body.data.items[0].attendanceTimeContext).toEqual({
      targetWorkDate: day(-4), effectiveTimezone: 'America/New_York',
      timezoneSource: 'legacy_record', mode: null, policyVersion: null,
      contextFingerprint: null, frozen: true,
    })
    expect(response.body.data.items[0].effective).toEqual({ isWorkingDay: true, source: 'stored_record' })
    expect(await state()).toEqual(before)
  })

  it('the no-DML observer detects a real UPDATE even when row counts do not change', async () => {
    const client = await live.pool.connect()
    let affected = 0
    try {
      await client.query('BEGIN')
      await expect(readWithoutBusinessDml(async () => {
        const result = await client.query('UPDATE attendance_rules SET name=name WHERE org_id=$1 AND is_default=true', [live.orgId])
        affected = result.rowCount ?? 0
      })).rejects.toThrow()
      expect(affected).toBe(1)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('fresh published calendar metadata follows same-TX holiday and policy inputs while stored history stays unchanged', async () => {
    const subject = await live.user()
    const workDate = day(20)
    const shiftId = randomUUID()
    const assignmentId = randomUUID()
    await live.pool.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,working_days)
      VALUES($1,$2,'read synthetic shift','UTC','09:00','18:00',$3::jsonb)`,
    [shiftId, live.orgId, JSON.stringify([0,1,2,3,4,5,6])])
    await live.pool.query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status)
      VALUES($1,$2,$3,$4,$5,$5,true,'published')`, [assignmentId,live.orgId,subject.userId,shiftId,workDate])
    const path = calendar(workDate, workDate, subject.userId)
    const original = await get(path, subject.token)
    expect(original.status, original.body.error?.code).toBe(200)
    expect(original.body.data.items[0].base).toEqual({ isWorkingDay:true, source:'shift' })
    await assertCalendarTargetParity(original, subject.token)
    await live.pool.query(`INSERT INTO attendance_records(id,org_id,user_id,work_date,timezone,first_in_at,last_out_at,status,is_workday,work_minutes)
      VALUES($1,$2,$3,$4,'America/New_York',$5,$6,'normal',true,480)`,
    [randomUUID(),live.orgId,subject.userId,day(-2),instant(-2,14),instant(-2,22)])
    const historical = await get(calendar(day(-2), day(-2), subject.userId), subject.token)
    expect(historical.status, historical.body.error?.code).toBe(200)
    expect(historical.body.data.items[0].attendanceTimeContext).toMatchObject({
      effectiveTimezone:'America/New_York',timezoneSource:'legacy_record',frozen:true,
    })
    const created = await live.request('/api/attendance/holidays', admin.token, {
      date:workDate, name:'Synthetic holiday-2', isWorkingDay:false,
    })
    expect(created.status, created.body.error?.code).toBe(201)
    const holiday = await get(path, subject.token)
    expect(holiday.status, holiday.body.error?.code).toBe(200)
    expect(holiday.body.data.items[0].base).toEqual({
      isWorkingDay:false, source:'manual', holidayId:created.body.data.id, name:'Synthetic holiday-2', dayIndex:2,
    })
    expect(holiday.body.data.items[0].layers).toEqual([{
      kind:'holiday', source:'manual', isWorkingDay:false, label:'Synthetic holiday-2', refId:created.body.data.id,
    }])
    await assertCalendarTargetParity(holiday, subject.token)
    const settings = await get('/api/attendance/settings', admin.token)
    expect(settings.status).toBe(200)
    const previous = settings.body.data.calendarPolicy.overrides
    const override = { id:'read-synthetic-day-policy', date:workDate, name:'Synthetic holiday-2', match:'equals',
      dayIndexList:[2], filters:{ userIds:[subject.userId] },
      effective:{ isWorkingDay:true, source:'user', label:'Synthetic working exception' } }
    const changed = await live.request('/api/attendance/settings',admin.token,
      {calendarPolicy:{overrides:[...previous,override]}},'PUT')
    expect(changed.status, changed.body.error?.code).toBe(200)
    try {
      const effective = await get(path, subject.token)
      expect(effective.status, effective.body.error?.code).toBe(200)
      expect(effective.body.data.items[0].base).toEqual(holiday.body.data.items[0].base)
      expect(effective.body.data.items[0].effective).toEqual({
        isWorkingDay:true, source:'user', label:'Synthetic working exception', policyId:override.id,
      })
      expect(effective.body.data.items[0].layers).toEqual([
        ...holiday.body.data.items[0].layers,
        {kind:'calendar_policy',source:'user',isWorkingDay:true,label:'Synthetic working exception',refId:override.id},
      ])
      expect(effective.body.data.items[0].attendanceTimeContext.contextFingerprint)
        .not.toBe(holiday.body.data.items[0].attendanceTimeContext.contextFingerprint)
      await assertCalendarTargetParity(effective, subject.token)
      // Another process may persist settings while this worker's TTL cache is warm.
      // Seed that persisted state directly, then prove the existing settings cache
      // is stale while the locked calendar/target readers see the new database facts.
      const persisted = (await live.pool.query('SELECT value FROM system_configs WHERE key=$1', ['attendance.settings'])).rows[0]
      const raw = typeof persisted.value === 'string' ? JSON.parse(persisted.value) : persisted.value
      const external = { ...override, effective:{...override.effective,isWorkingDay:false,label:'Synthetic external rest'} }
      await live.pool.query('UPDATE system_configs SET value=$2 WHERE key=$1',
        ['attendance.settings',JSON.stringify({...raw,calendarPolicy:{overrides:[...previous,external]}})])
      const staleSettings = await get('/api/attendance/settings', admin.token)
      expect(staleSettings.body.data.calendarPolicy.overrides.find((row: {id:string}) => row.id===override.id).effective.isWorkingDay).toBe(true)
      const refreshed = await get(path, subject.token)
      expect(refreshed.status, refreshed.body.error?.code).toBe(200)
      expect(refreshed.body.data.items[0].effective).toEqual({
        isWorkingDay:false,source:'user',label:'Synthetic external rest',policyId:override.id,
      })
      await assertCalendarTargetParity(refreshed, subject.token)
      const old = await get(calendar(day(-2), day(-2), subject.userId), subject.token)
      expect(old.status, old.body.error?.code).toBe(200)
      expect(old.body.data).toEqual(historical.body.data)
    } finally {
      const restored = await live.request('/api/attendance/settings',admin.token,{calendarPolicy:{overrides:previous}},'PUT')
      expect(restored.status, restored.body.error?.code).toBe(200)
    }
  })

  it('measures actual published target source SQL for one, seven and thirty-one days', async () => {
    const subject = await live.user()
    const shiftId = randomUUID()
    await live.pool.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,working_days)
      VALUES($1,$2,'published query synthetic','UTC','09:00','18:00',$3::jsonb)`,
      [shiftId,live.orgId,JSON.stringify([0,1,2,3,4,5,6])])
    await live.pool.query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status)
      VALUES($1,$2,$3,$4,$5,$6,true,'published')`,
      [randomUUID(),live.orgId,subject.userId,shiftId,day(90),day(120)])
    await live.pool.query(`INSERT INTO attendance_employee_timezone_overrides
      (org_id,user_id,timezone,effective_from,effective_to,created_by,updated_by)
      VALUES($1,$2,'Asia/Tokyo',$3,$4,$5,$5)`,
      [live.orgId,subject.userId,instant(91),instant(92),admin.userId])
    const prototype = require('pg').Client.prototype as { query:(...args:unknown[])=>unknown }
    const original = prototype.query
    const measurements = []
    for (const days of [1,7,31]) {
      let captured: Awaited<ReturnType<typeof get>>
      const counts:Record<string,number> = {queries:0}
      prototype.query = function(this:unknown,...args:unknown[]) {
        const arg=args[0] as string|{text?:string};const sql=typeof arg==='string'?arg:arg?.text||''
        counts.queries += 1
        for(const table of new Set([...sql.matchAll(/(?:FROM|JOIN)\s+(attendance_[a-z_0-9]+)/gi)].map(match=>match[1]))) {
          counts[table]=(counts[table]||0)+1
        }
        return Reflect.apply(original,this,args)
      }
      try {
        const response=await get(calendar(day(90),day(89+days),subject.userId),subject.token)
        captured=response
        expect(response.status,response.body.error?.code).toBe(200)
        expect(response.body.data.items).toHaveLength(days)
        expect(response.body.data.items.every((item:{base:{source:string},attendanceTimeContext:{contextFingerprint:string}})=>
          item.base.source==='shift' && typeof item.attendanceTimeContext.contextFingerprint==='string')).toBe(true)
      } finally {prototype.query=original}
      const representativeItems = captured!.body.data.items.slice(0,3)
      expect(representativeItems.map((item:{attendanceTimeContext:{effectiveTimezone:string}})=>
        item.attendanceTimeContext.effectiveTimezone)).toEqual(days===1 ? ['UTC'] : ['UTC','Asia/Tokyo','UTC'])
      await assertCalendarTargetParity({ ...captured!,body:{...captured!.body,data:{...captured!.body.data,items:representativeItems}} },subject.token)
      measurements.push({days,counts})
    }
    for (const {counts} of measurements) {
      // One unchanged published source across all dates: resolve each date's
      // context independently, but read its unchanged source facts once per batch.
      for (const table of ['attendance_shifts','attendance_shift_segments','attendance_calculation_context_source_state']) {
        expect(counts[table],table).toBeGreaterThan(0)
        expect(counts[table],table).toBe(measurements[0].counts[table])
      }
      expect(counts.queries).toBeLessThanOrEqual(measurements[0].counts.queries+5)
    }
    console.info('READ_CONTEXT_PUBLISHED_SQL_COUNTS '+JSON.stringify(measurements))
  })


  it('fresh calendar refuses unavailable scope facts even when target resolution needs no policy filters', async () => {
    const subject = await live.user()
    const workDate = day(130)
    const targetPath = '/api/attendance/timezone-context/me?workDate=' + workDate
    const path = calendar(workDate, workDate, subject.userId)
    const original = await get(path, subject.token)
    expect(original.status, original.body.error?.code).toBe(200)
    expect((await get(targetPath, subject.token)).status).toBe(200)
    const before = await state()
    await live.pool.query('ALTER TABLE attendance_group_members RENAME TO attendance_read_unavailable_scope_members')
    try {
      // Empty calendar overrides leave this optional filter source unused by
      // target resolution. The display layer must still refuse its own failure.
      const target = await get(targetPath, subject.token)
      expect(target.status, target.body.error?.code).toBe(200)
      const failed = await get(path, subject.token)
      expect(failed.status).toBe(503)
      expect(failed.body).toEqual({ ok:false, error:{
        code:'ATTENDANCE_TIMEZONE_SCOPE_SOURCE_UNAVAILABLE',
      } })
      expect(await state()).toEqual(before)
    } finally {
      await live.pool.query('ALTER TABLE attendance_read_unavailable_scope_members RENAME TO attendance_group_members')
    }
    const restored = await get(path, subject.token)
    expect(restored.status, restored.body.error?.code).toBe(200)
    expect(restored.body.data).toEqual(original.body.data)
    expect(await state()).toEqual(before)
  })


  async function leaveRangeFixture(offset: number, night = false) {
    const subject = await live.user()
    await live.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1", [subject.userId])
    const workDate = day(offset)
    const leaveTypeId = randomUUID()
    await live.pool.query("INSERT INTO attendance_leave_types(id,org_id,code,name) VALUES($1,$2,$3,'synthetic ordinary leave range')",
      [leaveTypeId, live.orgId, 'read_range_' + leaveTypeId])
    const flow = await live.request('/api/attendance/approval-flows', admin.token, {
      orgId: live.orgId, name: 'Synthetic leave range ' + randomUUID(), requestType: 'leave',
      steps: [{ approverUserIds: [admin.userId] }],
    })
    expect(flow.status, flow.body.error?.code).toBe(201)
    if (night) {
      const shiftId = randomUUID()
      await live.pool.query(`INSERT INTO attendance_shifts
        (id,org_id,name,timezone,work_start_time,work_end_time,is_overnight,working_days)
        VALUES($1,$2,'synthetic frozen night','UTC','22:00','06:00',true,$3::jsonb)`,
      [shiftId, live.orgId, JSON.stringify([0,1,2,3,4,5,6])])
      await live.pool.query(`INSERT INTO attendance_shift_assignments
        (id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status)
        VALUES($1,$2,$3,$4,$5,$5,true,'published')`,
      [randomUUID(), live.orgId, subject.userId, shiftId, workDate])
    }
    const target = await get('/api/attendance/timezone-context/me?workDate=' + workDate, subject.token)
    expect(target.status, target.body.error?.code).toBe(200)
    expect(target.body.data).toMatchObject({ orgId: live.orgId, userId: subject.userId, workDate, timezone: 'UTC' })
    const body = {
      orgId: live.orgId, workDate, requestType: 'leave', leaveTypeId, approvalFlowId: flow.body.data.id,
      operationId: randomUUID(), expectedTimezoneContextFingerprint: target.body.data.contextFingerprint,
      requestedInAt: instant(offset, night ? 22 : 9), requestedOutAt: instant(night ? offset + 1 : offset, night ? 6 : 11),
    }
    return { subject, workDate, toDate: day(offset + 1), target: target.body.data, body }
  }
  async function leaveRangeDurableState() {
    const requests = await live.pool.query('SELECT to_jsonb(r) AS row FROM attendance_requests r WHERE org_id=$1 ORDER BY id', [live.orgId])
    const approvals = await live.pool.query("SELECT id,status,version,form_snapshot FROM approval_instances WHERE form_snapshot->>'orgId'=$1 ORDER BY id", [live.orgId])
    const audit = await live.pool.query(`SELECT id,instance_id,action,from_status,to_status,from_version,to_version,metadata
      FROM approval_records WHERE instance_id IN
      (SELECT id FROM approval_instances WHERE form_snapshot->>'orgId'=$1) ORDER BY id`, [live.orgId])
    const operations = await live.pool.query('SELECT operation_id,state,version,command_fingerprint FROM attendance_result_operations WHERE org_id=$1 ORDER BY operation_id', [live.orgId])
    const snapshots = await live.pool.query('SELECT request_id,version,payload_fingerprint FROM attendance_request_calculation_snapshots WHERE org_id=$1 ORDER BY request_id,version', [live.orgId])
    return { counts: await state(), requests: requests.rows, approvals: approvals.rows, audit: audit.rows, operations: operations.rows, snapshots: snapshots.rows }
  }
  async function assertApprovedLeaveRange(fixture: Awaited<ReturnType<typeof leaveRangeFixture>>, requestId: string, minutes: number) {
    const approved = await live.request('/api/attendance/requests/' + requestId + '/approve', admin.token, { orgId: live.orgId })
    expect(approved.status, approved.body.error?.code).toBe(200)
    const requests = await live.pool.query(`SELECT work_date::text,status,(metadata->>'minutes')::int AS minutes,
      requested_in_at,requested_out_at FROM attendance_requests WHERE id=$1 AND org_id=$2`, [requestId, live.orgId])
    expect(requests.rows).toEqual([{
      work_date: fixture.workDate, status: 'approved', minutes,
      requested_in_at: new Date(fixture.body.requestedInAt), requested_out_at: new Date(fixture.body.requestedOutAt),
    }])
    const physical = await live.pool.query('SELECT work_date::text,timezone FROM attendance_records WHERE org_id=$1 AND user_id=$2 ORDER BY work_date', [live.orgId, fixture.subject.userId])
    expect(physical.rows).toEqual([{ work_date: fixture.workDate, timezone: 'UTC' }])
    const listed = await get('/api/attendance/records?orgId=' + live.orgId + '&from=' + fixture.workDate + '&to=' + fixture.toDate, fixture.subject.token)
    expect(listed.status, listed.body.error?.code).toBe(200)
    expect(listed.body.data.items.map((row: { work_date: string; timezone: string; meta: { leave_minutes: number } }) => ({
      work_date: row.work_date, timezone: row.timezone, leave_minutes: row.meta.leave_minutes,
    }))).toEqual([{ work_date: fixture.workDate, timezone: 'UTC', leave_minutes: minutes }])
  }

  it('same-day ordinary leave creates and approves exactly 120 minutes on its one target workDate', async () => {
    const fixture = await leaveRangeFixture(200)
    const created = await live.request('/api/attendance/requests', fixture.subject.token, fixture.body)
    expect(created.status, created.body.error?.code).toBe(201)
    await assertApprovedLeaveRange(fixture, created.body.data.request.id, 120)
  }, 60000)

  it('rejects 33-hour ordinary leave creation with no durable request, approval, snapshot, audit or record', async () => {
    const fixture = await leaveRangeFixture(201)
    const before = await leaveRangeDurableState()
    const rejected = await live.request('/api/attendance/requests', fixture.subject.token, {
      ...fixture.body, requestedOutAt: instant(202, 18),
    })
    expect(rejected.status, rejected.body.error?.code).toBe(409)
    expect(rejected.body).toEqual({ ok: false, error: {
      code: 'ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT', message: 'ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT',
    } })
    expect(await leaveRangeDurableState()).toEqual(before)
    expect(await live.counts(fixture.subject.userId)).toEqual({ events: 0, records: 0, requests: 0, operations: 0 })
  }, 60000)

  it('rejects a normalized crossday pending edit and preserves the original request and approval audit', async () => {
    const fixture = await leaveRangeFixture(203)
    const created = await live.request('/api/attendance/requests', fixture.subject.token, fixture.body)
    expect(created.status, created.body.error?.code).toBe(201)
    const pending = await get('/api/attendance/requests/' + created.body.data.request.id + '?orgId=' + live.orgId, fixture.subject.token)
    expect(pending.status, pending.body.error?.code).toBe(200)
    expect(pending.body.data.request).toMatchObject({ id: created.body.data.request.id, status: 'pending' })
    const cursor = pending.body.data.requestSnapshot
    expect(cursor).toEqual({ version: expect.any(Number), fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(cursor.version).toBeGreaterThan(0)
    const before = await leaveRangeDurableState()
    const rejected = await live.request('/api/attendance/requests/' + created.body.data.request.id, fixture.subject.token, {
      orgId: live.orgId, operationId: randomUUID(), clockOut: instant(204, 18),
      expectedSnapshotVersion: cursor.version, expectedSnapshotFingerprint: cursor.fingerprint,
      expectedTimezoneContextFingerprint: fixture.target.contextFingerprint,
    }, 'PUT')
    expect(rejected.status, rejected.body.error?.code).toBe(409)
    expect(rejected.body).toEqual({ ok: false, error: {
      code: 'ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT', message: 'ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT',
    } })
    expect(await leaveRangeDurableState()).toEqual(before)
    const original = await live.pool.query(`SELECT status,requested_in_at,requested_out_at,(metadata->>'minutes')::int AS minutes
      FROM attendance_requests WHERE id=$1`, [created.body.data.request.id])
    expect(original.rows).toEqual([{ status: 'pending', requested_in_at: new Date(fixture.body.requestedInAt), requested_out_at: new Date(fixture.body.requestedOutAt), minutes: 120 }])
  }, 60000)

  it('approves an interval crossing midnight entirely inside its published frozen night-shift window', async () => {
    const fixture = await leaveRangeFixture(205, true)
    expect(fixture.target.window).toEqual({ startAt: fixture.body.requestedInAt, endAt: fixture.body.requestedOutAt })
    const created = await live.request('/api/attendance/requests', fixture.subject.token, fixture.body)
    expect(created.status, created.body.error?.code).toBe(201)
    const stored = await live.pool.query('SELECT metadata FROM attendance_requests WHERE id=$1', [created.body.data.request.id])
    expect(stored.rows[0].metadata.timezoneContextV1).toMatchObject({
      workDate: fixture.workDate, timezone: 'UTC', window: fixture.target.window, contextFingerprint: fixture.target.contextFingerprint,
    })
    await assertApprovedLeaveRange(fixture, created.body.data.request.id, 480)
  }, 60000)

  it('refuses approval of a synthetic legacy pending illegal range without changing its frozen context or audit', async () => {
    const fixture = await leaveRangeFixture(207)
    const created = await live.request('/api/attendance/requests', fixture.subject.token, fixture.body)
    expect(created.status, created.body.error?.code).toBe(201)
    const requestId = created.body.data.request.id
    // Model a previously persisted illegal request: only this owned synthetic
    // row's endpoints/quantity change; status and its actual creation freeze stay.
    await live.pool.query(`UPDATE attendance_requests SET requested_out_at=$2,
      metadata=jsonb_set(metadata,'{minutes}','1980'::jsonb) WHERE id=$1 AND org_id=$3`,
    [requestId, instant(208, 18), live.orgId])
    const legacy = await live.pool.query('SELECT status,metadata FROM attendance_requests WHERE id=$1', [requestId])
    expect(legacy.rows[0]).toMatchObject({ status: 'pending', metadata: {
      minutes: 1980, timezoneContextV1: { contextFingerprint: fixture.target.contextFingerprint },
    } })
    const before = await leaveRangeDurableState()
    const rejected = await live.request('/api/attendance/requests/' + requestId + '/approve', admin.token, { orgId: live.orgId })
    expect(rejected.status, rejected.body.error?.code).toBe(409)
    expect(rejected.body).toEqual({ ok: false, error: {
      code: 'ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT', message: 'ATTENDANCE_TIMEZONE_REQUEST_RANGE_CONFLICT',
    } })
    expect(await leaveRangeDurableState()).toEqual(before)
    expect((await live.counts(fixture.subject.userId)).records).toBe(0)
  }, 60000)
})
