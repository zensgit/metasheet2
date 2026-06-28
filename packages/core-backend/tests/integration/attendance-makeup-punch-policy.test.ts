import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'

// 补卡规则 MP-2/MP-3 — makeup-punch (补卡) policy enforcement, route-level real-DB integration
// (design-lock attendance-makeup-punch-policy-design-lock-20260626.md §4-§5). Drives the real HTTP
// settings / requests / approve / reject routes against a migrated postgres and asserts every gate
// against attendance_requests / attendance_records / attendance_events.
//
// KEYSTONE: with makeupPunchPolicy.enabled !== true, create/edit/approve of the three makeup request
// types is byte-identical to today — no snapshot on the request metadata, no makeupPolicySnapshot on
// the adjustment event, the adjusted record still written, and cross-user PUT still succeeds. The
// "disabled = byte-identical" test below proves all of those NEGATIVES (field absence), which is what
// proves the new code cannot leak when the policy is off.

type HttpResponse = { status: number; body?: unknown; raw: string }

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

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const ORG = 'default'

type MakeupPolicy = {
  enabled?: boolean
  timezone?: string
  cycle?: { type?: string; startDay?: number }
  quota?: { maxRequestsPerCycle?: number; countStatuses?: string[]; principal?: string }
  submitWindow?: { unit?: string; days?: number }
  allowedAnomalyTypes?: string[]
  allowedRequestTypes?: string[]
  requireReason?: boolean
  requireAttachment?: boolean
}

type SeedRecord = {
  status?: string
  firstIn?: string | null
  lastOut?: string | null
  lateMinutes?: number
  earlyLeaveMinutes?: number
  meta?: Record<string, unknown>
}

const codeOf = (r: HttpResponse) => (r.body as { error?: { code?: string } } | undefined)?.error?.code
const requestIdOf = (r: HttpResponse) => (r.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id ?? ''

describeDb('补卡规则 MP-2/MP-3 makeup punch policy (real DB, route-level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool
  let adminToken = ''
  let adminUserId = ''
  let originalMakeup: MakeupPolicy | undefined

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  async function mintToken(userId: string, perms: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent(perms)}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }
  const putSettings = (body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: authHeaders(adminToken), body: JSON.stringify(body) })
  const getSettings = () => requestJson(`${baseUrl}/api/attendance/settings`, { headers: authHeaders(adminToken) })
  const createReq = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })
  const updateReq = (token: string, id: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/requests/${id}`, { method: 'PUT', headers: authHeaders(token), body: JSON.stringify(body) })
  const approve = (token: string, id: string) =>
    requestJson(`${baseUrl}/api/attendance/requests/${id}/approve`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ comment: 'ok' }) })
  const reject = (token: string, id: string) =>
    requestJson(`${baseUrl}/api/attendance/requests/${id}/reject`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ comment: 'no' }) })
  const anomalies = (token: string, userId: string, from: string, to: string) =>
    requestJson(`${baseUrl}/api/attendance/anomalies?userId=${encodeURIComponent(userId)}&from=${from}&to=${to}`, { headers: authHeaders(token) })

  // Date helpers in UTC so the test's date math matches the policy (timezone:'UTC' below).
  const dayKey = (offset: number): string => {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() + offset)
    return d.toISOString().slice(0, 10)
  }
  const weekdayOf = (workDate: string): number => new Date(`${workDate}T00:00:00.000Z`).getUTCDay()
  const at = (workDate: string, hhmm: string) => `${workDate}T${hhmm}:00.000Z`

  // Full policy shape on every PUT so a previous test's array never leaks through mergeSettings; nested
  // objects are deep-merged with the supplied override so a partial quota/window keeps its siblings.
  const makeupBase = (): Required<MakeupPolicy> => ({
    enabled: false,
    timezone: 'UTC',
    cycle: { type: 'calendar_month', startDay: 1 },
    quota: { maxRequestsPerCycle: 3, countStatuses: ['pending', 'approved'], principal: 'self_service_user' },
    submitWindow: { unit: 'calendar_day', days: 30 },
    allowedAnomalyTypes: ['missing_check_in', 'missing_check_out', 'late', 'severe_late', 'absence_late', 'early_leave'],
    allowedRequestTypes: ['missed_check_in', 'missed_check_out', 'time_correction'],
    requireReason: true,
    requireAttachment: false,
  })
  const setMakeup = (o: MakeupPolicy = {}) => {
    const b = makeupBase()
    const policy = {
      ...b,
      ...o,
      cycle: { ...b.cycle, ...(o.cycle || {}) },
      quota: { ...b.quota, ...(o.quota || {}) },
      submitWindow: { ...b.submitWindow, ...(o.submitWindow || {}) },
    }
    return putSettings({ makeupPunchPolicy: policy })
  }

  async function seedRecord(userId: string, workDate: string, opts: SeedRecord = {}) {
    await pool.query(
      `INSERT INTO attendance_records
       (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'UTC', $5, $6, 0, $7, $8, $9, true, $10::jsonb, NULL, now(), now())`,
      [
        randomUUID(),
        userId,
        ORG,
        workDate,
        opts.firstIn ?? null,
        opts.lastOut ?? null,
        opts.lateMinutes ?? 0,
        opts.earlyLeaveMinutes ?? 0,
        opts.status ?? 'partial',
        JSON.stringify(opts.meta ?? {}),
      ],
    )
  }
  // A 'partial' record missing the check-IN side → fact missing_check_in (the typical 补卡 case).
  const seedMissingCheckIn = (userId: string, workDate: string) =>
    seedRecord(userId, workDate, { status: 'partial', firstIn: null, lastOut: at(workDate, '18:00'), lateMinutes: 0 })
  const seedMissingCheckOut = (userId: string, workDate: string) =>
    seedRecord(userId, workDate, { status: 'partial', firstIn: at(workDate, '09:00'), lastOut: null, lateMinutes: 0 })
  const seedLate = (userId: string, workDate: string) =>
    seedRecord(userId, workDate, { status: 'late', firstIn: at(workDate, '09:30'), lastOut: at(workDate, '18:00'), lateMinutes: 30 })

  async function withDefaultWorkdayFor(workDate: string, run: () => Promise<void>): Promise<void> {
    const ruleId = randomUUID()
    const previousDefaultIds = (await pool.query(
      `SELECT id FROM attendance_rules WHERE org_id = $1 AND is_default = true`,
      [ORG],
    )).rows.map((row) => String(row.id))
    const previousHolidays = (await pool.query(
      `SELECT id, name, is_working_day, origin FROM attendance_holidays WHERE org_id = $1 AND holiday_date = $2`,
      [ORG, workDate],
    )).rows
    try {
      await pool.query(`UPDATE attendance_rules SET is_default = false, updated_at = now() WHERE org_id = $1 AND is_default = true`, [ORG])
      await pool.query(
        `INSERT INTO attendance_rules
         (id, org_id, name, timezone, work_start_time, work_end_time, late_grace_minutes, early_grace_minutes,
          severe_late_threshold_minutes, absence_late_threshold_minutes, rounding_minutes, working_days, is_default)
         VALUES ($1, $2, $3, 'UTC', '09:00', '18:00', 5, 5, 30, 60, 5, $4::jsonb, true)`,
        [ruleId, ORG, `mp-no-record-${ruleId}`, JSON.stringify([weekdayOf(workDate)])],
      )
      await pool.query(`DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = $2`, [ORG, workDate])
      await pool.query(
        `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
         VALUES ($1, $2, $3, $4, true, 'manual')`,
        [randomUUID(), ORG, workDate, 'MP no-record workday'],
      )
      await run()
    } finally {
      await pool.query(`DELETE FROM attendance_holidays WHERE org_id = $1 AND holiday_date = $2`, [ORG, workDate]).catch(() => undefined)
      for (const row of previousHolidays) {
        await pool.query(
          `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (org_id, holiday_date) DO UPDATE
           SET name = EXCLUDED.name, is_working_day = EXCLUDED.is_working_day, origin = EXCLUDED.origin, updated_at = now()`,
          [row.id, ORG, workDate, row.name ?? null, row.is_working_day === true, row.origin ?? 'manual'],
        ).catch(() => undefined)
      }
      await pool.query(`DELETE FROM attendance_rules WHERE id = $1`, [ruleId]).catch(() => undefined)
      if (previousDefaultIds.length > 0) {
        await pool.query(`UPDATE attendance_rules SET is_default = true, updated_at = now() WHERE id = ANY($1::uuid[])`, [previousDefaultIds]).catch(() => undefined)
      }
    }
  }

  async function reqRow(id: string): Promise<{ status: string; metadata: Record<string, unknown> } | null> {
    const row = (await pool.query(`SELECT status, metadata FROM attendance_requests WHERE id = $1`, [id])).rows[0]
    if (!row) return null
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {})
    return { status: String(row.status), metadata }
  }
  async function recordStatus(userId: string, workDate: string): Promise<string | null> {
    const row = (await pool.query(`SELECT status FROM attendance_records WHERE user_id = $1 AND work_date = $2 AND org_id = $3 LIMIT 1`, [userId, workDate, ORG])).rows[0]
    return row ? String(row.status) : null
  }
  async function adjustmentMetas(userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = (await pool.query(`SELECT meta FROM attendance_events WHERE user_id = $1 AND event_type = 'adjustment'`, [userId])).rows
    return rows.map((r) => (typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta ?? {})))
  }
  async function cleanupUser(userId: string) {
    await pool.query(`DELETE FROM approval_instances WHERE business_key IN (SELECT 'attendance-request:' || id FROM attendance_requests WHERE user_id = $1)`, [userId]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_requests WHERE user_id = $1`, [userId]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_events WHERE user_id = $1`, [userId]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_records WHERE user_id = $1`, [userId]).catch(() => undefined)
  }
  let userSeq = 0
  const uid = (prefix: string) => `mp-${prefix}-${Date.now().toString(36)}-${userSeq++}`

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('makeup punch integration needs a loopback port + DATABASE_URL')

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
    adminUserId = uid('admin')
    adminToken = await mintToken(adminUserId, 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const before = await getSettings()
    originalMakeup = (before.body as { data?: { makeupPunchPolicy?: MakeupPolicy } } | undefined)?.data?.makeupPunchPolicy
  })

  afterAll(async () => {
    if (adminToken && originalMakeup) await putSettings({ makeupPunchPolicy: originalMakeup }).catch(() => undefined)
    else if (adminToken) await setMakeup({ enabled: false }).catch(() => undefined)
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) await (server as unknown as { stop: () => Promise<void> }).stop()
    await pool?.end().catch(() => undefined)
  })

  // ── KEYSTONE: disabled = byte-identical ────────────────────────────────────────────────────────────
  it('disabled: create/edit/approve of makeup types byte-identical — no snapshot, no event meta, adjusted record, cross-user PUT ok', async () => {
    await setMakeup({ enabled: false })
    const u = uid('dis')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      // create with NO reason — disabled does not enforce requireReason
      const c = await createReq(tU, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00') })
      expect(c.status).toBe(201)
      const id = requestIdOf(c)
      expect(id).toBeTruthy()
      expect((await reqRow(id))?.metadata?.makeupPunchPolicySnapshot).toBeUndefined()

      // edit (still no snapshot)
      const e = await updateReq(tU, id, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:05') })
      expect(e.status).toBe(200)
      expect((await reqRow(id))?.metadata?.makeupPunchPolicySnapshot).toBeUndefined()

      // cross-user PUT by admin (canAccessOtherUsers) still succeeds when disabled
      const x = await updateReq(adminToken, id, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:10') })
      expect(x.status).toBe(200)

      // approve → adjusted record written, adjustment event has NO makeupPolicySnapshot
      const ap = await approve(adminToken, id)
      expect(ap.status).toBe(200)
      expect(await recordStatus(u, wd)).toBe('adjusted')
      const metas = await adjustmentMetas(u)
      expect(metas).toHaveLength(1)
      expect(metas[0].requestType).toBe('missed_check_in')
      expect(metas[0].makeupPolicySnapshot).toBeUndefined()
    } finally {
      await cleanupUser(u)
    }
  })

  // ── quota ────────────────────────────────────────────────────────────────────────────────────────
  it('quota max=1: 2nd makeup in cycle → QUOTA_EXCEEDED; reject releases the slot; update excludes self', async () => {
    await setMakeup({ enabled: true, quota: { maxRequestsPerCycle: 1 } })
    const u = uid('quota')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      // one record on `wd` yields BOTH missing_check_in (partial, no first_in) and late (lateMinutes>0)
      await seedRecord(u, wd, { status: 'partial', firstIn: null, lastOut: at(wd, '18:00'), lateMinutes: 30 })

      const c1 = await createReq(tU, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00'), reason: 'forgot in' })
      expect(c1.status).toBe(201)
      const id1 = requestIdOf(c1)

      // 2nd makeup (different type, same workDate→same cycle) blocked by quota
      const c2 = await createReq(tU, { requestType: 'time_correction', workDate: wd, requestedInAt: at(wd, '09:00'), reason: 'fix late' })
      expect(c2.status).toBe(422)
      expect(codeOf(c2)).toBe('MAKEUP_PUNCH_QUOTA_EXCEEDED')

      // editing the SAME request must exclude self → not quota-blocked
      const upd = await updateReq(tU, id1, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:01'), reason: 'forgot in (edited)' })
      expect(upd.status).toBe(200)

      // reject #1 → slot released → time_correction now allowed
      const rj = await reject(adminToken, id1)
      expect(rj.status).toBe(200)
      const c3 = await createReq(tU, { requestType: 'time_correction', workDate: wd, requestedInAt: at(wd, '09:00'), reason: 'fix late' })
      expect(c3.status).toBe(201)
    } finally {
      await cleanupUser(u)
    }
  })

  it('quota counts by workDate-in-cycle: a request in a different cycle does not consume this cycle quota', async () => {
    await setMakeup({ enabled: true, quota: { maxRequestsPerCycle: 1 }, submitWindow: { days: 180 } })
    const u = uid('cycle')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wdNow = dayKey(0)
    const wdOld = dayKey(-40) // always a prior calendar month → different cycle (startDay=1)
    try {
      await seedMissingCheckIn(u, wdNow)
      await seedMissingCheckIn(u, wdOld)
      const cOld = await createReq(tU, { requestType: 'missed_check_in', workDate: wdOld, requestedInAt: at(wdOld, '09:00'), reason: 'old' })
      expect(cOld.status).toBe(201)
      // current-cycle quota unaffected by the prior-cycle request
      const cNow = await createReq(tU, { requestType: 'missed_check_in', workDate: wdNow, requestedInAt: at(wdNow, '09:00'), reason: 'now' })
      expect(cNow.status).toBe(201)
    } finally {
      await cleanupUser(u)
    }
  })

  // ── window / future ────────────────────────────────────────────────────────────────────────────────
  it('submitWindow.days=0: yesterday → WINDOW_EXPIRED; today → ok', async () => {
    await setMakeup({ enabled: true, submitWindow: { days: 0 } })
    const u = uid('win')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const today = dayKey(0)
    const yest = dayKey(-1)
    try {
      await seedMissingCheckIn(u, today)
      const expired = await createReq(tU, { requestType: 'missed_check_in', workDate: yest, requestedInAt: at(yest, '09:00'), reason: 'late' })
      expect(expired.status).toBe(422)
      expect(codeOf(expired)).toBe('MAKEUP_PUNCH_WINDOW_EXPIRED')
      const ok = await createReq(tU, { requestType: 'missed_check_in', workDate: today, requestedInAt: at(today, '09:00'), reason: 'today' })
      expect(ok.status).toBe(201)
    } finally {
      await cleanupUser(u)
    }
  })

  it('future workDate → FUTURE_DATE_UNSUPPORTED (checked before window/type)', async () => {
    await setMakeup({ enabled: true, submitWindow: { days: 180 } })
    const u = uid('fut')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const tom = dayKey(1)
    try {
      const r = await createReq(tU, { requestType: 'missed_check_in', workDate: tom, requestedInAt: at(tom, '09:00'), reason: 'tomorrow' })
      expect(r.status).toBe(422)
      expect(codeOf(r)).toBe('MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED')
    } finally {
      await cleanupUser(u)
    }
  })

  // ── type gate ────────────────────────────────────────────────────────────────────────────────────
  it('allowedAnomalyTypes=[missing_check_in]: late time_correction → TYPE_NOT_ALLOWED; genuine missing_check_in passes', async () => {
    await setMakeup({ enabled: true, allowedAnomalyTypes: ['missing_check_in'] })
    const uLate = uid('typeL')
    const uMiss = uid('typeM')
    const tLate = await mintToken(uLate, 'attendance:read,attendance:write')
    const tMiss = await mintToken(uMiss, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      await seedLate(uLate, wd)
      const bad = await createReq(tLate, { requestType: 'time_correction', workDate: wd, requestedInAt: at(wd, '09:30'), reason: 'fix' })
      expect(bad.status).toBe(422)
      expect(codeOf(bad)).toBe('MAKEUP_PUNCH_TYPE_NOT_ALLOWED')

      await seedMissingCheckIn(uMiss, wd)
      const good = await createReq(tMiss, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00'), reason: 'forgot' })
      expect(good.status).toBe(201)
    } finally {
      await cleanupUser(uLate)
      await cleanupUser(uMiss)
    }
  })

  it('missing_check_out fact: genuine missed_check_out passes and snapshots matchedAnomalyTypes', async () => {
    await setMakeup({ enabled: true, allowedAnomalyTypes: ['missing_check_out'] })
    const u = uid('typeO')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      await seedMissingCheckOut(u, wd)
      const created = await createReq(tU, { requestType: 'missed_check_out', workDate: wd, requestedOutAt: at(wd, '18:00'), reason: 'forgot out' })
      expect(created.status).toBe(201)
      const snap = (await reqRow(requestIdOf(created)))?.metadata?.makeupPunchPolicySnapshot as Record<string, unknown> | undefined
      expect(snap?.matchedAnomalyTypes).toEqual(['missing_check_out'])
    } finally {
      await cleanupUser(u)
    }
  })

  it('no-record workday fact: missing-side requests pass from resolved default rule context', async () => {
    await setMakeup({ enabled: true, allowedAnomalyTypes: ['missing_check_in', 'missing_check_out'] })
    const uIn = uid('typeNoRecIn')
    const uOut = uid('typeNoRecOut')
    const tIn = await mintToken(uIn, 'attendance:read,attendance:write')
    const tOut = await mintToken(uOut, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      await withDefaultWorkdayFor(wd, async () => {
        expect(await recordStatus(uIn, wd)).toBeNull()
        expect(await recordStatus(uOut, wd)).toBeNull()

        const checkIn = await createReq(tIn, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00'), reason: 'forgot in entirely' })
        expect(checkIn.status).toBe(201)
        const checkInSnap = (await reqRow(requestIdOf(checkIn)))?.metadata?.makeupPunchPolicySnapshot as Record<string, unknown> | undefined
        expect(checkInSnap?.matchedAnomalyTypes).toEqual(['missing_check_in'])

        const checkOut = await createReq(tOut, { requestType: 'missed_check_out', workDate: wd, requestedOutAt: at(wd, '18:00'), reason: 'forgot out entirely' })
        expect(checkOut.status).toBe(201)
        const checkOutSnap = (await reqRow(requestIdOf(checkOut)))?.metadata?.makeupPunchPolicySnapshot as Record<string, unknown> | undefined
        expect(checkOutSnap?.matchedAnomalyTypes).toEqual(['missing_check_out'])
      })
    } finally {
      await cleanupUser(uIn)
      await cleanupUser(uOut)
    }
  })

  it('time_correction facts: late_early double-match and meta-derived severe/absence late tiers are enforced', async () => {
    const wd = dayKey(0)
    const uBoth = uid('typeBoth')
    const uSevere = uid('typeSev')
    const uAbsence = uid('typeAbs')
    const tBoth = await mintToken(uBoth, 'attendance:read,attendance:write')
    const tSevere = await mintToken(uSevere, 'attendance:read,attendance:write')
    const tAbsence = await mintToken(uAbsence, 'attendance:read,attendance:write')
    try {
      await setMakeup({ enabled: true })
      await seedRecord(uBoth, wd, {
        status: 'late_early',
        firstIn: at(wd, '09:30'),
        lastOut: at(wd, '17:30'),
        lateMinutes: 30,
        earlyLeaveMinutes: 30,
      })
      const both = await createReq(tBoth, {
        requestType: 'time_correction',
        workDate: wd,
        requestedInAt: at(wd, '09:00'),
        requestedOutAt: at(wd, '18:00'),
        reason: 'fix both sides',
      })
      expect(both.status).toBe(201)
      const bothSnap = (await reqRow(requestIdOf(both)))?.metadata?.makeupPunchPolicySnapshot as Record<string, unknown> | undefined
      expect(bothSnap?.matchedAnomalyTypes).toEqual(['late', 'early_leave'])

      await setMakeup({ enabled: true, allowedAnomalyTypes: ['severe_late'] })
      await seedRecord(uSevere, wd, {
        status: 'late',
        firstIn: at(wd, '11:00'),
        lastOut: at(wd, '18:00'),
        lateMinutes: 120,
        meta: { severe_late_count: 1, severe_late_minutes: 120 },
      })
      const severe = await createReq(tSevere, {
        requestType: 'time_correction',
        workDate: wd,
        requestedInAt: at(wd, '09:00'),
        reason: 'fix severe late',
      })
      expect(severe.status).toBe(201)
      const severeSnap = (await reqRow(requestIdOf(severe)))?.metadata?.makeupPunchPolicySnapshot as Record<string, unknown> | undefined
      expect(severeSnap?.matchedAnomalyTypes).toEqual(['severe_late'])

      await setMakeup({ enabled: true, allowedAnomalyTypes: ['absence_late'] })
      await seedRecord(uAbsence, wd, {
        status: 'late',
        firstIn: at(wd, '13:00'),
        lastOut: at(wd, '18:00'),
        lateMinutes: 240,
        meta: { absence_late_count: 1 },
      })
      const absence = await createReq(tAbsence, {
        requestType: 'time_correction',
        workDate: wd,
        requestedInAt: at(wd, '09:00'),
        reason: 'fix absence late',
      })
      expect(absence.status).toBe(201)
      const absenceSnap = (await reqRow(requestIdOf(absence)))?.metadata?.makeupPunchPolicySnapshot as Record<string, unknown> | undefined
      expect(absenceSnap?.matchedAnomalyTypes).toEqual(['absence_late'])
    } finally {
      await cleanupUser(uBoth)
      await cleanupUser(uSevere)
      await cleanupUser(uAbsence)
    }
  })

  it('unclassifiable record (no facts) + enabled → TYPE_NOT_ALLOWED fail-closed', async () => {
    await setMakeup({ enabled: true })
    const u = uid('failclosed')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      // a materialized whole-day 'absent' row yields NO makeup facts (absence routes to leave, not makeup)
      await seedRecord(u, wd, { status: 'absent', firstIn: null, lastOut: null })
      const r = await createReq(tU, { requestType: 'time_correction', workDate: wd, requestedInAt: at(wd, '09:00'), reason: 'whatever' })
      expect(r.status).toBe(422)
      expect(codeOf(r)).toBe('MAKEUP_PUNCH_TYPE_NOT_ALLOWED')
    } finally {
      await cleanupUser(u)
    }
  })

  // ── reason / attachment ───────────────────────────────────────────────────────────────────────────
  it('requireReason=true + empty reason → REASON_REQUIRED; requireAttachment=true + no attachment → ATTACHMENT_REQUIRED', async () => {
    const u = uid('reason')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      await setMakeup({ enabled: true, requireReason: true, requireAttachment: false })
      await seedMissingCheckIn(u, wd)
      const noReason = await createReq(tU, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00') })
      expect(noReason.status).toBe(422)
      expect(codeOf(noReason)).toBe('MAKEUP_PUNCH_REASON_REQUIRED')

      await setMakeup({ enabled: true, requireReason: false, requireAttachment: true })
      const noAtt = await createReq(tU, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00') })
      expect(noAtt.status).toBe(422)
      expect(codeOf(noAtt)).toBe('MAKEUP_PUNCH_ATTACHMENT_REQUIRED')

      const withAtt = await createReq(tU, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00'), attachmentUrl: 'https://example.com/proof.png' })
      expect(withAtt.status).toBe(201)
    } finally {
      await cleanupUser(u)
    }
  })

  // ── cross-user PUT ────────────────────────────────────────────────────────────────────────────────
  it('cross-user PUT on a makeup request: enabled → 422 CROSS_USER_FORBIDDEN; (disabled variant proven in keystone)', async () => {
    await setMakeup({ enabled: true })
    const u = uid('cross')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      await seedMissingCheckIn(u, wd)
      const c = await createReq(tU, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00'), reason: 'forgot' })
      expect(c.status).toBe(201)
      const id = requestIdOf(c)
      const x = await updateReq(adminToken, id, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:02'), reason: 'admin edit' })
      expect(x.status).toBe(422)
      expect(codeOf(x)).toBe('MAKEUP_PUNCH_CROSS_USER_FORBIDDEN')
    } finally {
      await cleanupUser(u)
    }
  })

  // ── anomaly prefill cannot bypass the gate ───────────────────────────────────────────────────────
  it('anomaly prefill goes through the same POST gate: a suggested type the policy disallows is still rejected', async () => {
    await setMakeup({ enabled: true, allowedAnomalyTypes: ['missing_check_in'] })
    const u = uid('prefill')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      await seedLate(u, wd)
      // anomalies route suggests time_correction for a late day...
      const an = await anomalies(adminToken, u, wd, wd)
      const items = (an.body as { data?: { items?: Array<{ suggestedRequestType?: string }> } } | undefined)?.data?.items ?? []
      expect(items.some((it) => it.suggestedRequestType === 'time_correction')).toBe(true)
      // ...but submitting that prefilled type is still rejected by the policy (suggestion ≠ authorization)
      const r = await createReq(tU, { requestType: 'time_correction', workDate: wd, requestedInAt: at(wd, '09:30'), reason: 'prefilled' })
      expect(r.status).toBe(422)
      expect(codeOf(r)).toBe('MAKEUP_PUNCH_TYPE_NOT_ALLOWED')
    } finally {
      await cleanupUser(u)
    }
  })

  // ── MP-3 approval audit ──────────────────────────────────────────────────────────────────────────
  it('approve: status=adjusted, adjustment event meta carries snapshot summary incl matchedAnomalyTypes; request snapshot persisted', async () => {
    await setMakeup({ enabled: true })
    const u = uid('audit')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      await seedMissingCheckIn(u, wd)
      const c = await createReq(tU, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00'), reason: 'forgot' })
      expect(c.status).toBe(201)
      const id = requestIdOf(c)
      const created = await reqRow(id)
      const snap = created?.metadata?.makeupPunchPolicySnapshot as Record<string, unknown> | undefined
      expect(snap).toBeTruthy()
      expect(snap?.version).toBe(1)
      expect(snap?.matchedAnomalyTypes).toEqual(['missing_check_in'])

      const ap = await approve(adminToken, id)
      expect(ap.status).toBe(200)
      expect(await recordStatus(u, wd)).toBe('adjusted')
      const metas = await adjustmentMetas(u)
      expect(metas).toHaveLength(1)
      const evSnap = metas[0].makeupPolicySnapshot as Record<string, unknown> | undefined
      expect(evSnap).toBeTruthy()
      expect(evSnap?.matchedAnomalyTypes).toEqual(['missing_check_in'])
      expect(evSnap?.version).toBe(1)
    } finally {
      await cleanupUser(u)
    }
  })

  it('snapshot immutability: tighten policy after create, then approve → uses the PERSISTED snapshot, not the new policy', async () => {
    await setMakeup({ enabled: true, allowedAnomalyTypes: ['missing_check_in'] })
    const u = uid('immut')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      await seedMissingCheckIn(u, wd)
      const c = await createReq(tU, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00'), reason: 'forgot' })
      expect(c.status).toBe(201)
      const id = requestIdOf(c)

      // tighten so a NEW missed_check_in would now be rejected (missing_check_in no longer allowed)
      await setMakeup({ enabled: true, allowedAnomalyTypes: ['late'] })
      const ap = await approve(adminToken, id)
      expect(ap.status).toBe(200) // pending request approves via its persisted snapshot
      expect(await recordStatus(u, wd)).toBe('adjusted')
      const metas = await adjustmentMetas(u)
      expect((metas[0].makeupPolicySnapshot as Record<string, unknown> | undefined)?.matchedAnomalyTypes).toEqual(['missing_check_in'])
    } finally {
      await cleanupUser(u)
    }
  })

  it('grandfather: a pending row created while disabled (no snapshot) approves unchanged even after the policy is enabled', async () => {
    await setMakeup({ enabled: false })
    const u = uid('grand')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      const c = await createReq(tU, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00') })
      expect(c.status).toBe(201)
      const id = requestIdOf(c)
      expect((await reqRow(id))?.metadata?.makeupPunchPolicySnapshot).toBeUndefined()

      await setMakeup({ enabled: true, allowedAnomalyTypes: ['late'] }) // would reject a new missed_check_in
      const ap = await approve(adminToken, id)
      expect(ap.status).toBe(200)
      expect(await recordStatus(u, wd)).toBe('adjusted')
      const metas = await adjustmentMetas(u)
      expect(metas).toHaveLength(1)
      expect(metas[0].makeupPolicySnapshot).toBeUndefined() // legacy path, byte-identical
    } finally {
      await cleanupUser(u)
    }
  })

  it('snapshot freshness on PUT: editing a makeup request recomputes the snapshot and preserves attachmentUrl', async () => {
    await setMakeup({ enabled: true })
    const u = uid('fresh')
    const tU = await mintToken(u, 'attendance:read,attendance:write')
    const wd = dayKey(0)
    try {
      await seedMissingCheckIn(u, wd)
      const c = await createReq(tU, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:00'), reason: 'forgot', attachmentUrl: 'https://example.com/a.png' })
      expect(c.status).toBe(201)
      const id = requestIdOf(c)
      const before = await reqRow(id)
      const snapBefore = before?.metadata?.makeupPunchPolicySnapshot as Record<string, unknown> | undefined
      expect(snapBefore?.version).toBe(1)
      expect((snapBefore?.quota as Record<string, unknown> | undefined)?.maxRequestsPerCycle).toBe(3) // base cap at create time
      expect(before?.metadata?.attachmentUrl).toBe('https://example.com/a.png')

      // CHANGE a snapshot-visible field between create and edit so the snapshot must visibly differ if it
      // is recomputed — a stale-inherit bug (carrying the create-time snapshot) would leave cap=3 and fail.
      await setMakeup({ enabled: true, quota: { maxRequestsPerCycle: 7 } })
      // edit reason only; do not resend attachmentUrl → sibling must be preserved, snapshot recomputed fresh
      const e = await updateReq(tU, id, { requestType: 'missed_check_in', workDate: wd, requestedInAt: at(wd, '09:01'), reason: 'forgot (edited)' })
      expect(e.status).toBe(200)
      const after = await reqRow(id)
      const snapAfter = after?.metadata?.makeupPunchPolicySnapshot as Record<string, unknown> | undefined
      expect(snapAfter?.version).toBe(1)
      expect(snapAfter?.matchedAnomalyTypes).toEqual(['missing_check_in'])
      expect((snapAfter?.quota as Record<string, unknown> | undefined)?.maxRequestsPerCycle).toBe(7) // proves recompute, not stale-inherit
      expect(after?.metadata?.attachmentUrl).toBe('https://example.com/a.png') // not silently dropped
    } finally {
      await cleanupUser(u)
    }
  })
})
