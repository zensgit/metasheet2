#!/usr/bin/env node
// O6 staging smoke — 加班三段引擎 (workday/restday/holiday overtime buckets).
//
// Validates the overtime segmentation chain on real staging:
//   O1 helper · O2 request metadata snapshot · O3 records/summary loaders ·
//   O4 report fields/sync inputs · O5 comp-time grant amount.
//
// It drives the real HTTP API and uses SQL for exact request/ledger assertions
// and cleanup. It restores attendance settings and deletes only rows bearing its
// unique synthetic user/stamp.

import { randomUUID } from 'crypto'
import pg from 'pg'

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const ORG_ID = process.env.ORG_ID || 'default'
if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://u@127.0.0.1:5432/metasheet [SMOKE_TOKEN=<jwt>] node scripts/ops/staging-attendance-overtime-segmentation-o6-smoke.mjs')
  process.exit(2)
}

const SUFFIX = Date.now().toString(36)
const STAMP = `overtime-o6-${SUFFIX}`
const USER = process.env.SMOKE_USER_ID || `overtime-o6-${SUFFIX}`
let token = process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let cleanupAllowed = false
let originalSettings = null
const created = { holidayId: null, overtimeRuleId: null, requestIds: [] }

const EXPECTED_DEPLOY_SHA = process.env.EXPECTED_DEPLOY_SHA || ''

function mondayInOctober(year) {
  const d = new Date(Date.UTC(year, 9, 1))
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

const seedYear = Number(process.env.SMOKE_YEAR || '') || (2040 + (Number.parseInt(SUFFIX.slice(-3), 36) % 40))
const WORK_DATE = process.env.WORK_DATE || mondayInOctober(seedYear)
const HOLIDAY_DATE = process.env.HOLIDAY_DATE || addDays(WORK_DATE, 2)
const REST_DATE = process.env.REST_DATE || addDays(WORK_DATE, 6)
const FROM_DATE = [WORK_DATE, HOLIDAY_DATE, REST_DATE].sort()[0]
const TO_DATE = [WORK_DATE, HOLIDAY_DATE, REST_DATE].sort()[2]

const expected = {
  [WORK_DATE]: { dayType: 'workday', total: 45, workday: 45, restday: 0, holiday: 0 },
  [REST_DATE]: { dayType: 'restday', total: 75, workday: 0, restday: 75, holiday: 0 },
  [HOLIDAY_DATE]: { dayType: 'holiday', total: 105, workday: 0, restday: 0, holiday: 105 },
}

let pass = 0
const failures = []
function ok(condition, label, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.error(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const scopedPath = /(?:^|[?&])orgId=/.test(path)
    ? path
    : `${path}${path.includes('?') ? '&' : '?'}orgId=${encodeURIComponent(ORG_ID)}`
  const headers = { 'Content-Type': 'application/json', 'x-org-id': ORG_ID }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE_URL}${scopedPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, body: json }
}

function jwtSubject(jwt) {
  try {
    const segment = String(jwt).split('.')[1]
    if (!segment) return null
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    return payload.id ?? payload.sub ?? payload.userId ?? payload.user_id ?? null
  } catch {
    return null
  }
}

const pool = new pg.Pool({ connectionString: DATABASE_URL })
const q = (text, params) => pool.query(text, params).then((result) => result.rows)

async function ensureToken() {
  if (!/^overtime-o6-/.test(USER) && process.env.ALLOW_NON_SYNTHETIC_SMOKE_USER !== '1') {
    throw new Error(`refusing to run: subject "${USER}" is not a synthetic overtime-o6- id. Cleanup deletes this user's attendance requests/records/ledger rows. Use a synthetic SMOKE_USER_ID or set ALLOW_NON_SYNTHETIC_SMOKE_USER=1 (dangerous).`)
  }

  if (!token) {
    const perms = 'attendance:read,attendance:write,attendance:admin,attendance:approve'
    const res = await api(`/api/auth/dev-token?userId=${encodeURIComponent(USER)}&roles=admin&perms=${encodeURIComponent(perms)}`)
    token = res.body?.token || ''
    if (!token) {
      throw new Error(`could not mint dev-token (status ${res.status}) — pass SMOKE_TOKEN + SMOKE_USER_ID for staging with dev-token disabled`)
    }
    console.log('  minted dev-token for synthetic overtime segmentation smoke user')
  } else {
    const subject = jwtSubject(token)
    if (subject == null) throw new Error('could not decode SMOKE_TOKEN subject — supply a valid JWT or omit SMOKE_TOKEN to use dev-token.')
    if (String(subject) !== USER) {
      throw new Error(`SMOKE_TOKEN subject "${subject}" != SMOKE_USER_ID "${USER}". Requests would be attributed to the token subject while assertions/cleanup target "${USER}".`)
    }
    console.log(`  using supplied SMOKE_TOKEN (subject ${subject})`)
  }
  cleanupAllowed = true
}

async function saveSettings(update) {
  const res = await api('/api/attendance/settings', { method: 'PUT', body: update })
  ok(res.status === 200, `save settings ${Object.keys(update).join(',')} (status ${res.status})`, res.body)
  if (res.status !== 200) throw new Error('settings update failed')
}

async function createOvertimeRule() {
  const res = await api('/api/attendance/overtime-rules', {
    method: 'POST',
    body: {
      name: `${STAMP}-rule`,
      minMinutes: 0,
      roundingMinutes: 1,
      maxMinutesPerDay: 0,
      requiresApproval: true,
      isActive: true,
    },
  })
  const id = res.body?.data?.id
  ok(res.status === 201 && !!id, `create overtime rule (status ${res.status})`, res.body)
  if (!id) throw new Error('overtime rule was not created')
  return id
}

async function createAndApproveOvertime(overtimeRuleId, workDate, minutes) {
  const create = await api('/api/attendance/requests', {
    method: 'POST',
    body: {
      workDate,
      requestType: 'overtime',
      overtimeRuleId,
      minutes,
      reason: `${STAMP} ${workDate}`,
    },
  })
  const requestId = create.body?.data?.request?.id
  ok(create.status === 201 && !!requestId, `create overtime ${workDate} (${minutes}m)`, create.body)
  if (!requestId) throw new Error(`request was not created for ${workDate}`)

  const approve = await api(`/api/attendance/requests/${requestId}/approve`, {
    method: 'POST',
    body: { comment: `${STAMP} approve ${workDate}` },
  })
  ok(approve.status === 200, `approve overtime ${workDate} (status ${approve.status})`, approve.body)
  if (approve.status !== 200) throw new Error(`approve failed for ${workDate}`)
  return requestId
}

function dateOnly(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  return new Date(value).toISOString().slice(0, 10)
}

function normalizeSnapshot(value) {
  return value && typeof value === 'object' ? value : {}
}

function assertSnapshot(workDate, metadata) {
  const expectation = expected[workDate]
  const snapshot = normalizeSnapshot(metadata?.overtimeSegmentation ?? metadata?.overtime_segmentation)
  const segments = normalizeSnapshot(snapshot.segments)
  ok(snapshot.version === 1 && snapshot.engine === 'attendance_overtime_segmentation_v1',
    `${workDate}: request metadata has versioned engine snapshot`, snapshot)
  ok(snapshot.workDate === workDate && snapshot.dayType === expectation.dayType,
    `${workDate}: snapshot dayType=${expectation.dayType}`, snapshot)
  ok(Number(snapshot.totalMinutes ?? 0) === expectation.total && Number(snapshot.compTimeGrantMinutes ?? 0) === expectation.total,
    `${workDate}: snapshot total + compTimeGrant match`, snapshot)
  ok(Number(segments.workdayMinutes ?? 0) === expectation.workday
      && Number(segments.restdayMinutes ?? 0) === expectation.restday
      && Number(segments.holidayMinutes ?? 0) === expectation.holiday,
    `${workDate}: snapshot bucket totals`, segments)
}

function assertRecord(workDate, record) {
  const expectation = expected[workDate]
  const meta = normalizeSnapshot(record?.meta)
  const projection = normalizeSnapshot(meta.approvedOvertimeSegmentation ?? meta.approved_overtime_segmentation)
  const reportValues = normalizeSnapshot(record?.reportValues ?? record?.report_values)
  ok(!!record, `${workDate}: record exists`)
  ok(Number(meta.overtimeMinutes ?? meta.overtime_minutes ?? 0) === expectation.total,
    `${workDate}: record total overtime minutes`, meta)
  ok(Number(projection.workdayOvertimeMinutes ?? projection.workday_overtime_minutes ?? 0) === expectation.workday
      && Number(projection.restdayOvertimeMinutes ?? projection.restday_overtime_minutes ?? 0) === expectation.restday
      && Number(projection.holidayOvertimeMinutes ?? projection.holiday_overtime_minutes ?? 0) === expectation.holiday
      && Number(projection.compTimeGrantMinutes ?? projection.comp_time_grant_minutes ?? 0) === expectation.total,
    `${workDate}: record approvedOvertimeSegmentation projection`, projection)
  ok(Number(reportValues.overtime_approval_duration ?? 0) === expectation.total
      && Number(reportValues.workday_overtime_duration ?? 0) === expectation.workday
      && Number(reportValues.restday_overtime_duration ?? 0) === expectation.restday
      && Number(reportValues.holiday_overtime_duration ?? 0) === expectation.holiday,
    `${workDate}: report_values use segment buckets`, reportValues)
}

function effectiveDayType(item) {
  const effective = normalizeSnapshot(item?.effective)
  const layers = Array.isArray(item?.layers) ? item.layers : []
  if (effective.isWorkingDay === true || effective.is_working_day === true) return 'workday'
  const hasHolidayLayer = layers.some((layer) => String(layer?.kind || '').includes('holiday'))
  return hasHolidayLayer ? 'holiday' : 'restday'
}

async function main() {
  console.log(`O6 overtime segmentation staging smoke @ ${BASE_URL} (user ${USER}, stamp ${STAMP})`)
  console.log(`  dates: workday=${WORK_DATE}, holiday=${HOLIDAY_DATE}, restday=${REST_DATE}`)

  await ensureToken()
  const settingsRes = await api('/api/attendance/settings')
  ok(settingsRes.status === 200, `auth: GET settings 200 (got ${settingsRes.status})`, settingsRes.body)
  if (settingsRes.status !== 200) throw new Error('cannot authenticate to staging')
  originalSettings = settingsRes.body?.data ?? {}

  if (EXPECTED_DEPLOY_SHA) {
    console.log(`  expected deploy SHA: ${EXPECTED_DEPLOY_SHA}`)
  }

  const existingHolidayRows = await q(
    `SELECT holiday_date::text AS holiday_date, name, origin
       FROM attendance_holidays
      WHERE org_id = $1
        AND holiday_date = ANY($2::date[])`,
    [ORG_ID, [WORK_DATE, REST_DATE, HOLIDAY_DATE]],
  )
  ok(existingHolidayRows.length === 0,
    'smoke dates have no pre-existing holiday rows before seeding', existingHolidayRows)
  if (existingHolidayRows.length > 0) {
    throw new Error('refusing to overwrite existing holiday rows; rerun with WORK_DATE/HOLIDAY_DATE/REST_DATE in an unused range')
  }

  const holidayId = randomUUID()
  await q(
    `INSERT INTO attendance_holidays (id, org_id, holiday_date, name, is_working_day, origin)
     VALUES ($1, $2, $3, $4, false, 'manual')`,
    [holidayId, ORG_ID, HOLIDAY_DATE, `${STAMP} holiday`],
  )
  created.holidayId = holidayId

  await saveSettings({
    overtimeSegmentation: { enabled: true },
    compTimeFromOvertime: { enabled: true },
  })

  const roundTrip = await api('/api/attendance/settings')
  const settings = roundTrip.body?.data ?? {}
  ok(settings.overtimeSegmentation?.enabled === true && settings.compTimeFromOvertime?.enabled === true,
    'O6 deployed: overtimeSegmentation + compTimeFromOvertime round-trip through settings', settings)
  if (settings.overtimeSegmentation?.enabled !== true) throw new Error('overtimeSegmentation setting did not persist')

  const effectiveRes = await api(`/api/attendance/effective-calendar?from=${FROM_DATE}&to=${TO_DATE}&userId=${encodeURIComponent(USER)}`)
  ok(effectiveRes.status === 200, `effective-calendar returns 200 (got ${effectiveRes.status})`, effectiveRes.body)
  const effectiveByDate = new Map((effectiveRes.body?.data?.items ?? []).map(item => [dateOnly(item.date ?? item.workDate ?? item.work_date), item]))
  for (const workDate of [WORK_DATE, REST_DATE, HOLIDAY_DATE]) {
    const item = effectiveByDate.get(workDate)
    ok(effectiveDayType(item) === expected[workDate].dayType,
      `${workDate}: effective-calendar parity dayType=${expected[workDate].dayType}`, item)
  }

  const overtimeRuleId = await createOvertimeRule()
  created.overtimeRuleId = overtimeRuleId
  const requestIds = []
  for (const [date, minutes] of [
    [WORK_DATE, expected[WORK_DATE].total],
    [REST_DATE, expected[REST_DATE].total],
    [HOLIDAY_DATE, expected[HOLIDAY_DATE].total],
  ]) {
    const requestId = await createAndApproveOvertime(overtimeRuleId, date, minutes)
    requestIds.push(requestId)
    created.requestIds.push(requestId)
  }

  const requestRows = await q(
    `SELECT id::text AS id, work_date::text AS work_date, status, metadata
       FROM attendance_requests
      WHERE id = ANY($1::uuid[])
      ORDER BY work_date`,
    [requestIds],
  )
  ok(requestRows.length === 3 && requestRows.every(row => row.status === 'approved'),
    'all three overtime requests are approved', requestRows.map(row => ({ id: row.id, status: row.status, workDate: row.work_date })))
  for (const row of requestRows) assertSnapshot(row.work_date, row.metadata)

  const recordsRes = await api(`/api/attendance/records?userId=${encodeURIComponent(USER)}&from=${FROM_DATE}&to=${TO_DATE}`)
  ok(recordsRes.status === 200, `GET /records returns 200 (got ${recordsRes.status})`, recordsRes.body)
  const recordsByDate = new Map((recordsRes.body?.data?.items ?? []).map(item => [dateOnly(item.workDate ?? item.work_date), item]))
  for (const workDate of [WORK_DATE, REST_DATE, HOLIDAY_DATE]) {
    assertRecord(workDate, recordsByDate.get(workDate))
  }

  const summaryRes = await api(`/api/attendance/summary?userId=${encodeURIComponent(USER)}&from=${FROM_DATE}&to=${TO_DATE}`)
  ok(summaryRes.status === 200, `GET /summary returns 200 (got ${summaryRes.status})`, summaryRes.body)
  const summary = summaryRes.body?.data ?? {}
  ok(Number(summary.overtime_minutes ?? summary.overtimeMinutes ?? 0) === 225
      && Number(summary.workday_overtime_minutes ?? summary.workdayOvertimeMinutes ?? 0) === 45
      && Number(summary.restday_overtime_minutes ?? summary.restdayOvertimeMinutes ?? 0) === 75
      && Number(summary.holiday_overtime_minutes ?? summary.holidayOvertimeMinutes ?? 0) === 105
      && Number(summary.comp_time_grant_minutes ?? summary.compTimeGrantMinutes ?? 0) === 225,
    'summary exposes total + workday/restday/holiday/comp-time buckets', summary)

  const lotRows = await q(
    `SELECT source_id::text AS source_id, source_key, amount_minutes, remaining_minutes, leave_type_code, status
       FROM attendance_leave_balances
      WHERE org_id = $1
        AND user_id = $2
        AND source_type = 'overtime_conversion'
        AND source_id::text = ANY($3::text[])
      ORDER BY amount_minutes`,
    [ORG_ID, USER, requestIds],
  )
  ok(lotRows.length === 3, 'comp-time grant wrote one lot per approved overtime request', lotRows)
  const lotAmounts = lotRows.map(row => Number(row.amount_minutes)).sort((a, b) => a - b).join(',')
  ok(lotAmounts === '45,75,105'
      && lotRows.every(row => row.leave_type_code === 'comp_time' && row.status === 'active' && Number(row.remaining_minutes) === Number(row.amount_minutes)),
    'comp-time lots consume compTimeGrantMinutes buckets (45,75,105)', lotRows)

  const eventRows = await q(
    `SELECT source_id::text AS source_id, event_type, delta_minutes
       FROM attendance_leave_balance_events
      WHERE org_id = $1
        AND user_id = $2
        AND source_type = 'overtime_conversion'
        AND source_id::text = ANY($3::text[])
      ORDER BY delta_minutes`,
    [ORG_ID, USER, requestIds],
  )
  const eventAmounts = eventRows.map(row => Number(row.delta_minutes)).sort((a, b) => a - b).join(',')
  ok(eventRows.length === 3 && eventAmounts === '45,75,105' && eventRows.every(row => row.event_type === 'grant'),
    'comp-time grant events match lot amounts and source ids', eventRows)
}

async function cleanup() {
  console.log('\n--- restore + cleanup ---')
  if (!cleanupAllowed) {
    console.log('  cleanup skipped: safety gates did not pass, so nothing was created')
    return
  }
  const requestIds = Array.isArray(created.requestIds) ? created.requestIds : []
  try {
    if (originalSettings) {
      await api('/api/attendance/settings', { method: 'PUT', body: originalSettings }).catch(() => undefined)
      console.log('  settings restored')
    }
    if (requestIds.length > 0) {
      await q(
        `DELETE FROM attendance_leave_balance_events
          WHERE org_id = $1 AND user_id = $2 AND source_type = 'overtime_conversion' AND source_id::text = ANY($3::text[])`,
        [ORG_ID, USER, requestIds],
      ).catch(() => undefined)
      await q(
        `DELETE FROM attendance_leave_balances
          WHERE org_id = $1 AND user_id = $2 AND source_type = 'overtime_conversion' AND source_id::text = ANY($3::text[])`,
        [ORG_ID, USER, requestIds],
      ).catch(() => undefined)
      await q(
        `DELETE FROM attendance_events
          WHERE org_id = $1 AND user_id = $2 AND meta->>'requestId' = ANY($3::text[])`,
        [ORG_ID, USER, requestIds],
      ).catch(() => undefined)
      await q(
        `DELETE FROM attendance_records
          WHERE org_id = $1 AND user_id = $2 AND work_date = ANY($3::date[])`,
        [ORG_ID, USER, [WORK_DATE, REST_DATE, HOLIDAY_DATE]],
      ).catch(() => undefined)
      await q(
        `DELETE FROM attendance_requests WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [ORG_ID, requestIds],
      ).catch(() => undefined)
    }
    if (created.holidayId) {
      await q('DELETE FROM attendance_holidays WHERE org_id = $1 AND id = $2', [ORG_ID, created.holidayId]).catch(() => undefined)
    }
    if (created.overtimeRuleId) {
      await q('DELETE FROM attendance_overtime_rules WHERE org_id = $1 AND id = $2', [ORG_ID, created.overtimeRuleId]).catch(() => undefined)
    }

    const residue = {
      requests: requestIds.length > 0 ? Number((await q('SELECT COUNT(*)::int AS count FROM attendance_requests WHERE id = ANY($1::uuid[])', [requestIds]))[0]?.count ?? 0) : 0,
      records: Number((await q(
        'SELECT COUNT(*)::int AS count FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = ANY($3::date[])',
        [ORG_ID, USER, [WORK_DATE, REST_DATE, HOLIDAY_DATE]],
      ))[0]?.count ?? 0),
      events: Number((await q(
        'SELECT COUNT(*)::int AS count FROM attendance_events WHERE org_id = $1 AND user_id = $2 AND work_date = ANY($3::date[])',
        [ORG_ID, USER, [WORK_DATE, REST_DATE, HOLIDAY_DATE]],
      ))[0]?.count ?? 0),
      lots: requestIds.length > 0 ? Number((await q(
        `SELECT COUNT(*)::int AS count FROM attendance_leave_balances
          WHERE org_id = $1 AND user_id = $2 AND source_type = 'overtime_conversion' AND source_id::text = ANY($3::text[])`,
        [ORG_ID, USER, requestIds],
      ))[0]?.count ?? 0) : 0,
      lotEvents: requestIds.length > 0 ? Number((await q(
        `SELECT COUNT(*)::int AS count FROM attendance_leave_balance_events
          WHERE org_id = $1 AND user_id = $2 AND source_type = 'overtime_conversion' AND source_id::text = ANY($3::text[])`,
        [ORG_ID, USER, requestIds],
      ))[0]?.count ?? 0) : 0,
      holidays: created.holidayId ? Number((await q('SELECT COUNT(*)::int AS count FROM attendance_holidays WHERE id = $1', [created.holidayId]))[0]?.count ?? 0) : 0,
      overtimeRules: created.overtimeRuleId ? Number((await q('SELECT COUNT(*)::int AS count FROM attendance_overtime_rules WHERE id = $1', [created.overtimeRuleId]))[0]?.count ?? 0) : 0,
    }
    const residueTotal = Object.values(residue).reduce((sum, value) => sum + Number(value || 0), 0)
    ok(residueTotal === 0, `cleanup residue = 0 (${Object.entries(residue).map(([k, v]) => `${k} ${v}`).join(', ')})`, residue)
  } finally {
    await pool.end().catch(() => undefined)
  }
}

try {
  await main()
} catch (error) {
  failures.push(error?.message || String(error))
  console.error(`\nERROR: ${error?.stack || error}`)
} finally {
  await cleanup()
}

if (failures.length > 0) {
  console.error(`\n=== FAIL — ${pass} passed, ${failures.length} failed ===  stamp ${STAMP}`)
  process.exit(1)
}

console.log(`\n=== PASS — ${pass} passed, 0 failed ===  stamp ${STAMP}`)
console.log(`OVERTIME_SEGMENTATION_O6_STAGING_SMOKE_PASS deploy=${EXPECTED_DEPLOY_SHA || 'unknown'} stamp=${STAMP} residue=0`)
