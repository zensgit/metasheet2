#!/usr/bin/env node
// OT-bank v1-8 staging smoke helper — overtime-bank accrual / leave-offset / cycle-close settlement API/DB chain.
//
// This helper drives the real staging HTTP API for every business write (settings PUT,
// overtime-rule / leave-type / holiday / request create, approve, payroll-cycle create/close),
// and uses SQL only for synthetic seed (users, the poison balance lot), exact assertions
// (per-source lot tagging and attendance_payroll_cycle_settlements have NO API read surface
// until the v1-5d read exit lands), and stamped cleanup. It intentionally does NOT claim the
// final v1-8 staging closeout; the operator-decision blocks and the final stamp live in
// docs/development/attendance-overtime-bank-v18-staging-smoke-runbook-20260702.md.
//
// Cases (compressed replay of the owner's three settlement acceptance cases, in minutes):
//   case1: OT +600 pooled, leave 600 → deduct 600, remaining 0, shortfall 0, convertible 0
//   case2: OT +600 pooled, leave 300 → deduct 300, remaining 300, shortfall 0, convertible 300
//   case3: OT +600 pooled, leave 900 → deduct 600 (partial), remaining 0, shortfall 300, convertible 0
// plus: dormant-bank NULL-source grant regression, statutory-holiday must-pay boundary with a
// poison 9999 statutory balance lot, replay idempotency (approve replay + close replay), frozen
// cycle guards, full-attendance flag, ledger conservation, settings restore, residue=0.

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// --- pure helpers (exported for the companion .test.mjs) -----------------------------------

export const STAMP_PATTERN = /^otbank-v18-smoke-[A-Za-z0-9-]+$/

export const RESTORED_POLICY_KEYS = [
  'overtimeSegmentation',
  'compTimeFromOvertime',
  'overtimeBankPolicy',
  'leaveBalanceDeductionPolicy',
  'attendanceBonusPolicy',
]

// Compressed three-case plan (owner acceptance table, hours → minutes).
export const CASE_PLAN = [
  { key: 'case1', otMinutes: 600, leaveMinutes: 600, expectDeductMinutes: 600, expectRemainingMinutes: 0, expectShortfallMinutes: 0, expectConvertibleMinutes: 0 },
  { key: 'case2', otMinutes: 600, leaveMinutes: 300, expectDeductMinutes: 300, expectRemainingMinutes: 300, expectShortfallMinutes: 0, expectConvertibleMinutes: 300 },
  { key: 'case3', otMinutes: 600, leaveMinutes: 900, expectDeductMinutes: 600, expectRemainingMinutes: 0, expectShortfallMinutes: 300, expectConvertibleMinutes: 0 },
]

export function stableJson(value) {
  return JSON.stringify(value ?? null)
}

export function jwtSubject(jwt) {
  try {
    const seg = String(jwt).split('.')[1]
    if (!seg) return null
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))
    return payload.id ?? payload.sub ?? payload.userId ?? null
  } catch {
    return null
  }
}

export function addDays(date, days) {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

export function isWeekend(ymd) {
  const dow = new Date(`${ymd}T00:00:00.000Z`).getUTCDay()
  return dow === 0 || dow === 6
}

export function firstMondayOfMonth(year, monthIndex) {
  const d = new Date(Date.UTC(year, monthIndex, 1))
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export function lastDayOfMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10)
}

// Far-future year so the settlement period contains no real staging records/requests and no
// synced holiday rows (same isolation trick as the O6 segmentation smoke's 2040+ seed years).
export function pickSmokeYear(suffix, override) {
  const parsedOverride = Number.parseInt(String(override ?? ''), 10)
  if (Number.isInteger(parsedOverride) && parsedOverride >= 2030 && parsedOverride <= 2099) return parsedOverride
  const seed = Number.parseInt(String(suffix).slice(-3), 36)
  return 2041 + ((Number.isFinite(seed) ? seed : 0) % 30)
}

// One month = one settlement window: OT on the first Monday (workday), leave offset on the
// Tuesday, seeded statutory holiday + holiday OT on the Wednesday; cycle spans the full month.
export function buildSmokeWindow(year) {
  const monthIndex = 9 // October
  const otDate = firstMondayOfMonth(year, monthIndex)
  return {
    year,
    periodStart: `${year}-10-01`,
    periodEnd: lastDayOfMonth(year, monthIndex),
    otDate,
    leaveDate: addDays(otDate, 1),
    holidayDate: addDays(otDate, 2),
  }
}

// PUT /api/attendance/settings deep-merges per policy key (mergeSettings), so restoring by
// PUT-ing an empty snapshot is a NO-OP that leaks this smoke's policies (#3303 lesson). The
// restore body must explicitly re-assert every toggled policy key, defaulting to disabled when
// the pre-smoke settings never carried it.
export function buildRestoreSettingsBody(originalSettings) {
  const original = originalSettings && typeof originalSettings === 'object' ? originalSettings : {}
  return {
    ...original,
    overtimeSegmentation: { enabled: false, ...(original.overtimeSegmentation ?? {}) },
    compTimeFromOvertime: { enabled: false, ...(original.compTimeFromOvertime ?? {}) },
    overtimeBankPolicy: { enabled: false, pooledSources: [], ...(original.overtimeBankPolicy ?? {}) },
    leaveBalanceDeductionPolicy: { enabled: false, rules: [], ...(original.leaveBalanceDeductionPolicy ?? {}) },
    attendanceBonusPolicy: { enabled: false, ...(original.attendanceBonusPolicy ?? {}) },
  }
}

export function isStampedId(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length
}

export function parseJson(value) {
  if (value == null || typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

// Env-only contract (no CLI args), mirroring the AE-4 helper: BASE_URL/DATABASE_URL required,
// DEPLOY_SHA mandatory (the PASS stamp must name the staging build actually smoked), STAMP
// regex-locked so cleanup remains visibly synthetic and LIKE-free.
export function resolveEnvConfig(env = {}) {
  const errors = []
  const baseUrl = String(env.BASE_URL || env.BASE || '').replace(/\/$/, '')
  const databaseUrl = String(env.DATABASE_URL || '')
  const orgId = String(env.ORG_ID || 'default')
  const deploySha = String(env.DEPLOY_SHA || env.EXPECTED_DEPLOY_SHA || '')
  if (!baseUrl || !databaseUrl) {
    errors.push('BASE_URL and DATABASE_URL are required.')
  }
  if (!deploySha || deploySha === '<fill-from-staging-build>') {
    errors.push('DEPLOY_SHA is required so the PASS stamp names the staging build that was actually smoked.')
  }
  const suffix = Date.now().toString(36)
  const stamp = String(env.STAMP || `otbank-v18-smoke-${suffix}`)
  if (!STAMP_PATTERN.test(stamp)) {
    errors.push('STAMP must match /^otbank-v18-smoke-[A-Za-z0-9-]+$/ so cleanup remains visibly synthetic and LIKE-free.')
  }
  return {
    ok: errors.length === 0,
    errors,
    config: {
      baseUrl,
      databaseUrl,
      orgId,
      deploySha,
      stamp,
      suffix,
      year: pickSmokeYear(suffix, env.SMOKE_YEAR),
      allowNonSyntheticPopulation: env.ALLOW_NON_SYNTHETIC_SETTLEMENT_POPULATION === '1',
    },
  }
}

// --- runtime wiring -------------------------------------------------------------------------

const IS_MAIN = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
const ENTRY = resolveEnvConfig(process.env)
if (IS_MAIN && !ENTRY.ok) {
  for (const message of ENTRY.errors) console.error(`FAIL: ${message}`)
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet DEPLOY_SHA=<deployed-sha> ADMIN_TOKEN=<jwt> node scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs')
  process.exit(2)
}

const { baseUrl: BASE_URL, databaseUrl: DATABASE_URL, orgId: ORG_ID, deploySha: DEPLOY_SHA, stamp: STAMP } = ENTRY.config
const USER_PREFIX = `${STAMP}-`
const KEY_PREFIX = `otbank-v18-smoke:${STAMP}:`

const USERS = {
  admin: process.env.ADMIN_USER_ID || `${USER_PREFIX}admin`,
  case1: process.env.CASE1_USER_ID || `${USER_PREFIX}case1`,
  case2: process.env.CASE2_USER_ID || `${USER_PREFIX}case2`,
  case3: process.env.CASE3_USER_ID || `${USER_PREFIX}case3`,
  mustpay: process.env.MUSTPAY_USER_ID || `${USER_PREFIX}mustpay`,
  dormant: process.env.DORMANT_USER_ID || `${USER_PREFIX}dormant`,
}
const BUSINESS_USER_KEYS = ['case1', 'case2', 'case3', 'mustpay', 'dormant']
const USER_TOKEN_ENVS = {
  case1: 'CASE1_TOKEN',
  case2: 'CASE2_TOKEN',
  case3: 'CASE3_TOKEN',
  mustpay: 'MUSTPAY_TOKEN',
  dormant: 'DORMANT_TOKEN',
}

let adminToken = process.env.ADMIN_TOKEN || process.env.SMOKE_TOKEN || process.env.TOKEN || ''
const userTokens = {}
let originalSettings = null
let cleanupAllowed = false
let populationSyntheticOnly = false
let smokeWindow = null
let pass = 0
const failures = []

const created = {
  overtimeRuleId: null,
  leaveTypeId: null,
  leaveTypeCode: `${STAMP}-offset`,
  overtimeRuleName: `${STAMP}-ot-rule`,
  holidayName: `${STAMP} statutory holiday`,
  cycleName: `${STAMP}-cycle`,
  poisonLotKey: `${KEY_PREFIX}poison-statutory-lot`,
  holidayIds: [],
  cycleIds: [],
  requestIds: [],
  approvalInstanceIds: new Set(),
}

let pool = null
const q = (text, params = []) => pool.query(text, params).then(result => result.rows)

function ok(condition, label, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failures.push(label)
  const suffix = detail === undefined ? '' : ` - ${JSON.stringify(detail)}`
  console.error(`  FAIL  ${label}${suffix}`)
}

function assertSyntheticUser(userId, label) {
  if (isStampedId(userId, USER_PREFIX)) return
  throw new Error(`refusing to run: ${label} "${userId}" is not stamped with ${USER_PREFIX}. This smoke deletes its synthetic users during cleanup.`)
}

function authHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    'x-org-id': ORG_ID,
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function api(token, pathname, { method = 'GET', body } = {}) {
  const url = new URL(`${BASE_URL}${pathname}`)
  if (!url.searchParams.has('orgId')) url.searchParams.set('orgId', ORG_ID)
  const res = await fetch(url, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* non-json */ }
  return { status: res.status, body: json }
}

async function mintToken(userId, { roles = 'user', perms }) {
  const res = await api('', `/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`)
  const token = res.body?.token || ''
  if (!token) {
    throw new Error(`could not mint dev-token for ${userId} (status ${res.status}); provide explicit ADMIN_TOKEN/CASE1_TOKEN/... for staging environments that disable dev-token`)
  }
  return token
}

async function resolveTokens() {
  assertSyntheticUser(USERS.admin, 'ADMIN_USER_ID')
  for (const key of BUSINESS_USER_KEYS) assertSyntheticUser(USERS[key], `${key} user id`)
  if (!adminToken) {
    adminToken = await mintToken(USERS.admin, {
      roles: 'admin',
      perms: 'attendance:read,attendance:write,attendance:admin,attendance:approve',
    })
    console.log('  minted admin dev-token')
  } else {
    const subject = jwtSubject(adminToken)
    if (subject != null) console.log(`  using supplied admin token (subject ${subject})`)
  }
  for (const key of BUSINESS_USER_KEYS) {
    const supplied = process.env[USER_TOKEN_ENVS[key]] || ''
    if (supplied) {
      // Requests are created AS the token subject; a mismatched supplied token would attribute
      // business rows to a user this smoke does not clean up.
      const subject = jwtSubject(supplied)
      if (subject !== USERS[key]) {
        throw new Error(`${USER_TOKEN_ENVS[key]} subject "${subject}" does not equal ${key} user id "${USERS[key]}"`)
      }
      userTokens[key] = supplied
      console.log(`  using supplied ${key} token (subject ${subject})`)
    } else {
      userTokens[key] = await mintToken(USERS[key], { roles: 'user', perms: 'attendance:read,attendance:write' })
      console.log(`  minted ${key} dev-token`)
    }
  }
}

async function preflightDatabase() {
  const row = (await q(
    `SELECT
       to_regclass('public.users') IS NOT NULL AS users_ok,
       to_regclass('public.user_orgs') IS NOT NULL AS user_orgs_ok,
       to_regclass('public.attendance_requests') IS NOT NULL AS requests_ok,
       to_regclass('public.attendance_records') IS NOT NULL AS records_ok,
       to_regclass('public.attendance_events') IS NOT NULL AS events_ok,
       to_regclass('public.attendance_leave_types') IS NOT NULL AS leave_types_ok,
       to_regclass('public.attendance_overtime_rules') IS NOT NULL AS overtime_rules_ok,
       to_regclass('public.attendance_holidays') IS NOT NULL AS holidays_ok,
       to_regclass('public.attendance_leave_balances') IS NOT NULL AS leave_balances_ok,
       to_regclass('public.attendance_leave_balance_events') IS NOT NULL AS balance_events_ok,
       to_regclass('public.attendance_payroll_cycles') IS NOT NULL AS cycles_ok,
       to_regclass('public.attendance_payroll_cycle_settlements') IS NOT NULL AS settlements_ok,
       to_regclass('public.attendance_notification_deliveries') IS NOT NULL AS deliveries_ok,
       to_regclass('public.approval_instances') IS NOT NULL AS approval_instances_ok,
       to_regclass('public.approval_assignments') IS NOT NULL AS approval_assignments_ok,
       to_regclass('public.approval_records') IS NOT NULL AS approval_records_ok,
       to_regclass('public.system_configs') IS NOT NULL AS settings_ok`,
  ))[0] || {}
  const ready = Object.values(row).every(value => value === true)
  ok(ready, 'DB assertion channel reachable and OT-bank v1-8 tables exist (incl attendance_payroll_cycle_settlements)', row)
  if (!ready) throw new Error('staging DB missing OT-bank v1-8 tables (is the v1-5a settlement migration applied?) or DATABASE_URL points at the wrong database')
}

async function preflightNoExistingResidue() {
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM users WHERE left(id, $2) = $3) AS users,
       (SELECT count(*)::int FROM user_orgs WHERE org_id = $1 AND left(user_id, $2) = $3) AS user_orgs,
       (SELECT count(*)::int FROM attendance_requests WHERE org_id = $1 AND left(user_id, $2) = $3) AS requests,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND left(user_id, $2) = $3) AS records,
       (SELECT count(*)::int FROM attendance_leave_balances
         WHERE org_id = $1 AND (left(user_id, $2) = $3 OR source_key = $4)) AS leave_balances,
       (SELECT count(*)::int FROM attendance_leave_types WHERE org_id = $1 AND code = $5) AS leave_types,
       (SELECT count(*)::int FROM attendance_overtime_rules WHERE org_id = $1 AND name = $6) AS overtime_rules,
       (SELECT count(*)::int FROM attendance_holidays WHERE org_id = $1 AND name = $7) AS holidays,
       (SELECT count(*)::int FROM attendance_payroll_cycles WHERE org_id = $1 AND metadata->>'smokeStamp' = $8) AS cycles,
       (SELECT count(*)::int FROM attendance_payroll_cycle_settlements s
         JOIN attendance_payroll_cycles c ON c.id = s.cycle_id AND c.org_id = s.org_id
         WHERE s.org_id = $1 AND c.metadata->>'smokeStamp' = $8) AS settlements`,
    [ORG_ID, USER_PREFIX.length, USER_PREFIX, created.poisonLotKey, created.leaveTypeCode, created.overtimeRuleName, created.holidayName, STAMP],
  ))[0] || {}
  const clean = Object.values(row).every(value => Number(value) === 0)
  ok(clean, 'no pre-existing residue for this OT-bank smoke stamp', row)
  if (!clean) throw new Error(`pre-existing residue found for ${STAMP}; use a fresh STAMP or inspect before running`)
}

async function getSettings() {
  const res = await api(adminToken, '/api/attendance/settings')
  ok(res.status === 200, `GET settings through staging API (status ${res.status})`, res.body)
  if (res.status !== 200) throw new Error('cannot read attendance settings')
  return res.body?.data ?? {}
}

async function putSettings(update, label) {
  const res = await api(adminToken, '/api/attendance/settings', { method: 'PUT', body: update })
  ok(res.status === 200, `${label} (status ${res.status})`, res.body)
  if (res.status !== 200) throw new Error(`settings update failed: ${label}`)
  return res.body?.data ?? {}
}

async function verifySettingsCoherence() {
  const row = (await q(
    `SELECT value::jsonb #> '{overtimeBankPolicy}' AS policy
     FROM system_configs
     WHERE key = 'attendance.settings'
     LIMIT 1`,
  ))[0]
  const policy = row?.policy ?? null
  const coherent = policy && typeof policy === 'object'
  ok(Boolean(coherent), 'API settings write is visible through DATABASE_URL', policy)
  if (!coherent) throw new Error('BASE_URL and DATABASE_URL do not appear coherent for attendance settings')
}

// Far-future window with ZERO pre-existing facts: no overlapping payroll cycle, no holiday rows
// on the smoke dates, and no records/requests from ANY user inside the period — this keeps the
// section-8a settlement population's period arm synthetic-only by construction.
async function chooseWindow() {
  let year = ENTRY.config.year
  for (let i = 0; i < 12; i += 1) {
    const candidate = buildSmokeWindow(year)
    const row = (await q(
      `SELECT
         (SELECT count(*)::int FROM attendance_payroll_cycles
           WHERE org_id = $1 AND start_date <= $3::date AND end_date >= $2::date) AS overlapping_cycles,
         (SELECT count(*)::int FROM attendance_holidays
           WHERE org_id = $1 AND holiday_date IN ($4::date, $5::date, $6::date)) AS holiday_rows,
         (SELECT count(*)::int FROM attendance_records
           WHERE org_id = $1 AND work_date BETWEEN $2 AND $3) AS period_records,
         (SELECT count(*)::int FROM attendance_requests
           WHERE org_id = $1 AND work_date BETWEEN $2 AND $3) AS period_requests`,
      [ORG_ID, candidate.periodStart, candidate.periodEnd, candidate.otDate, candidate.leaveDate, candidate.holidayDate],
    ))[0] || {}
    const clean = Object.values(row).every(value => Number(value) === 0)
    if (clean) {
      ok(true, `chose conflict-free far-future settlement window ${candidate.periodStart}..${candidate.periodEnd}`, candidate)
      return candidate
    }
    year += 1
  }
  throw new Error('could not find a conflict-free far-future settlement window; pass SMOKE_YEAR explicitly')
}

async function seedUsers() {
  for (const key of BUSINESS_USER_KEYS) {
    const userId = USERS[key]
    assertSyntheticUser(userId, 'smoke user')
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, role, is_active)
       VALUES ($1, $2, 'no-login', $3, 'user', true)
       ON CONFLICT (id) DO UPDATE SET is_active = true, email = EXCLUDED.email, name = EXCLUDED.name`,
      [userId, `${userId}@example.test`, userId],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
      [userId, ORG_ID],
    )
  }
  cleanupAllowed = true
  ok(true, 'seeded synthetic case/mustpay/dormant users', { stamp: STAMP })
}

async function captureApprovalInstanceId(requestId) {
  const rows = await q('SELECT approval_instance_id FROM attendance_requests WHERE id = $1 AND org_id = $2', [requestId, ORG_ID])
  const approvalId = rows[0]?.approval_instance_id
  if (approvalId) created.approvalInstanceIds.add(String(approvalId))
}

async function postRequest(userKey, body) {
  const res = await api(userTokens[userKey], '/api/attendance/requests', { method: 'POST', body: { orgId: ORG_ID, ...body } })
  const id = res.body?.data?.request?.id ?? null
  if (id) {
    created.requestIds.push(String(id))
    await captureApprovalInstanceId(id)
  }
  return { res, id }
}

async function approveRequest(requestId) {
  return api(adminToken, `/api/attendance/requests/${requestId}/approve`, {
    method: 'POST',
    body: { comment: `OTBANK v1-8 smoke ${STAMP} approve` },
  })
}

async function lotsByRequest(requestId) {
  return q(
    `SELECT source_key, overtime_source, amount_minutes, remaining_minutes, status, expires_at
     FROM attendance_leave_balances
     WHERE org_id = $1 AND source_type = 'overtime_conversion' AND source_id = $2
     ORDER BY source_key ASC`,
    [ORG_ID, requestId],
  )
}

async function grantEventsByRequest(requestId) {
  return q(
    `SELECT delta_minutes FROM attendance_leave_balance_events
     WHERE org_id = $1 AND event_type = 'grant' AND source_type = 'overtime_conversion' AND source_id = $2`,
    [ORG_ID, requestId],
  )
}

async function deductedMinutesForLeave(userId, leaveRequestId) {
  const rows = await q(
    `SELECT COALESCE(SUM(-delta_minutes), 0)::int AS deducted
     FROM attendance_leave_balance_events
     WHERE org_id = $1 AND user_id = $2 AND event_type = 'deduct' AND source_type = 'leave_offset' AND source_id = $3`,
    [ORG_ID, userId, leaveRequestId],
  )
  return Number(rows[0]?.deducted ?? 0)
}

async function leaveBalanceSummary(userId) {
  const res = await api(adminToken, `/api/attendance/leave-balances?userId=${encodeURIComponent(userId)}&leaveTypeCode=comp_time`)
  if (res.status !== 200) return { status: res.status }
  const summary = res.body?.data?.summary ?? {}
  return {
    status: res.status,
    grantedMinutes: Number(summary.grantedMinutes ?? -1),
    remainingMinutes: Number(summary.remainingMinutes ?? -1),
    exhaustedMinutes: Number(summary.exhaustedMinutes ?? -1),
    expiredMinutes: Number(summary.expiredMinutes ?? -1),
  }
}

async function settlementRows(cycleId) {
  return q(
    `SELECT user_id, source, convertible_minutes, must_pay_minutes,
            period_start_date::text AS period_start_date, period_end_date::text AS period_end_date,
            closed_at, snapshot
     FROM attendance_payroll_cycle_settlements
     WHERE org_id = $1 AND cycle_id = $2
     ORDER BY user_id ASC, source ASC`,
    [ORG_ID, cycleId],
  )
}

function settlementProjection(rows) {
  return rows.map(row => ({
    user: row.user_id,
    source: row.source,
    convertible: Number(row.convertible_minutes),
    mustPay: Number(row.must_pay_minutes),
  }))
}

// --- phases ----------------------------------------------------------------------------------

async function setupFixtures() {
  const rule = await api(adminToken, '/api/attendance/overtime-rules', {
    method: 'POST',
    body: { name: created.overtimeRuleName, minMinutes: 0, roundingMinutes: 1 },
  })
  ok(rule.status === 201 && rule.body?.data?.id, 'created stamped overtime rule (minMinutes=0, roundingMinutes=1)', rule.body)
  created.overtimeRuleId = rule.body?.data?.id ?? null
  if (!created.overtimeRuleId) throw new Error('overtime rule creation failed')

  const leaveType = await api(adminToken, '/api/attendance/leave-types', {
    method: 'POST',
    body: { code: created.leaveTypeCode, name: `${STAMP} offset leave`, paid: true, requiresApproval: true },
  })
  ok(leaveType.status === 201 && leaveType.body?.data?.id, 'created stamped offset leave type', leaveType.body)
  created.leaveTypeId = leaveType.body?.data?.id ?? null
  if (!created.leaveTypeId) throw new Error('leave type creation failed')
}

async function assertDormantGrantRegression() {
  await putSettings({
    overtimeSegmentation: { enabled: true },
    compTimeFromOvertime: { enabled: true, expiresInDays: null },
    overtimeBankPolicy: { enabled: false, pooledSources: [] },
  }, 'enable segmentation + comp-time grant with overtimeBankPolicy DORMANT')
  await verifySettingsCoherence()

  const { res, id } = await postRequest('dormant', {
    workDate: smokeWindow.otDate,
    requestType: 'overtime',
    overtimeRuleId: created.overtimeRuleId,
    minutes: 120,
    reason: `OTBANK v1-8 smoke ${STAMP} dormant regression`,
  })
  ok(res.status === 201 && id, `dormant: overtime request created (status ${res.status})`, res.body)
  if (!id) throw new Error('dormant overtime request creation failed')
  const approve = await approveRequest(id)
  ok(approve.status === 200, 'dormant: overtime approved', approve.body)

  const lots = await lotsByRequest(id)
  ok(
    lots.length === 1
      && lots[0]?.source_key === `overtime_conversion:${id}`
      && lots[0]?.overtime_source == null
      && Number(lots[0]?.amount_minutes) === 120
      && Number(lots[0]?.remaining_minutes) === 120
      && lots[0]?.expires_at == null,
    'dormant bank keeps the single NULL-source lot (legacy grant path, no expiry)',
    lots,
  )
  const events = await grantEventsByRequest(id)
  ok(events.length === 1 && Number(events[0]?.delta_minutes) === 120, 'dormant: exactly one +120 grant ledger event', events)
}

async function enableBankAndOffsetPolicies() {
  const rejected = await api(adminToken, '/api/attendance/settings', {
    method: 'PUT',
    body: { overtimeBankPolicy: { enabled: true, pooledSources: ['statutory_holiday'] } },
  })
  ok(rejected.status === 400, 'PUT pooledSources=[statutory_holiday] is rejected with 400 (compliance floor)', rejected.body)

  await putSettings({
    overtimeBankPolicy: { enabled: true, pooledSources: ['workday'] },
    leaveBalanceDeductionPolicy: {
      enabled: true,
      rules: [{ requestLeaveType: created.leaveTypeCode, deductFrom: ['comp_time'], insufficient: 'partial_unpaid_absence' }],
    },
    attendanceBonusPolicy: { enabled: true, anyLeaveBreaksFullAttendance: true, lateBeyondThresholdBreaksFullAttendance: true },
  }, 'enable overtimeBankPolicy(workday) + leave-offset rule + full-attendance flag')
}

async function runOwnerCase(plan) {
  const userId = USERS[plan.key]
  const ot = await postRequest(plan.key, {
    workDate: smokeWindow.otDate,
    requestType: 'overtime',
    overtimeRuleId: created.overtimeRuleId,
    minutes: plan.otMinutes,
    reason: `OTBANK v1-8 smoke ${STAMP} ${plan.key} overtime accrual`,
  })
  ok(ot.res.status === 201 && ot.id, `${plan.key}: overtime request created`, ot.res.body)
  if (!ot.id) throw new Error(`${plan.key}: overtime request creation failed`)
  const otApprove = await approveRequest(ot.id)
  ok(otApprove.status === 200, `${plan.key}: overtime approved`, otApprove.body)

  const lots = await lotsByRequest(ot.id)
  ok(
    lots.length === 1
      && lots[0]?.source_key === `overtime_conversion:${ot.id}:workday`
      && lots[0]?.overtime_source === 'workday'
      && Number(lots[0]?.amount_minutes) === plan.otMinutes,
    `${plan.key}: bank grant is one per-source workday lot of ${plan.otMinutes}`,
    lots,
  )

  const replay = await approveRequest(ot.id)
  ok(replay.status === 400 && replay.body?.error?.code === 'INVALID_STATUS', `${plan.key}: replay approve rejected with 400 INVALID_STATUS`, replay.body)
  const lotsAfterReplay = await lotsByRequest(ot.id)
  const grantEvents = await grantEventsByRequest(ot.id)
  ok(lotsAfterReplay.length === 1 && grantEvents.length === 1, `${plan.key}: replay approve did not double-credit lot/event`)

  const before = await leaveBalanceSummary(userId)
  ok(
    before.status === 200 && before.grantedMinutes === plan.otMinutes && before.remainingMinutes === plan.otMinutes,
    `${plan.key}: comp_time balance reads granted=${plan.otMinutes}, remaining=${plan.otMinutes} before offset`,
    before,
  )

  const leave = await postRequest(plan.key, {
    workDate: smokeWindow.leaveDate,
    requestType: 'leave',
    leaveTypeCode: created.leaveTypeCode,
    minutes: plan.leaveMinutes,
    reason: `OTBANK v1-8 smoke ${STAMP} ${plan.key} leave offset ${plan.leaveMinutes}m`,
  })
  ok(leave.res.status === 201 && leave.id, `${plan.key}: leave request created (${plan.leaveMinutes}m)`, leave.res.body)
  if (!leave.id) throw new Error(`${plan.key}: leave request creation failed`)
  const leaveApprove = await approveRequest(leave.id)
  ok(leaveApprove.status === 200, `${plan.key}: leave approved (offset rule, insufficient=partial_unpaid_absence)`, leaveApprove.body)

  const deducted = await deductedMinutesForLeave(userId, leave.id)
  ok(deducted === plan.expectDeductMinutes, `${plan.key}: FIFO offset deducted exactly ${plan.expectDeductMinutes}m from comp_time`, { deducted })
  const shortfall = plan.leaveMinutes - deducted
  ok(shortfall === plan.expectShortfallMinutes, `${plan.key}: real-absence shortfall is ${plan.expectShortfallMinutes}m (requested - deducted)`, { shortfall })

  const after = await leaveBalanceSummary(userId)
  ok(
    after.status === 200
      && after.remainingMinutes === plan.expectRemainingMinutes
      && after.exhaustedMinutes === plan.expectDeductMinutes
      && after.grantedMinutes === plan.otMinutes
      && after.expiredMinutes === 0,
    `${plan.key}: post-offset balance remaining=${plan.expectRemainingMinutes}, exhausted=${plan.expectDeductMinutes}`,
    after,
  )
  ok(
    after.grantedMinutes === after.remainingMinutes + after.exhaustedMinutes + after.expiredMinutes,
    `${plan.key}: ledger conservation holds (granted = remaining + exhausted + expired)`,
    after,
  )
}

async function assertStatutoryMustPaySetup() {
  const holiday = await api(adminToken, '/api/attendance/holidays', {
    method: 'POST',
    body: { date: smokeWindow.holidayDate, name: created.holidayName, isWorkingDay: false },
  })
  ok(holiday.status === 201 && holiday.body?.data?.id, 'created stamped statutory holiday for the must-pay boundary', holiday.body)
  const holidayId = holiday.body?.data?.id
  if (holidayId) created.holidayIds.push(String(holidayId))
  if (!holidayId) throw new Error('holiday creation failed')

  const ot = await postRequest('mustpay', {
    workDate: smokeWindow.holidayDate,
    requestType: 'overtime',
    overtimeRuleId: created.overtimeRuleId,
    minutes: 480,
    reason: `OTBANK v1-8 smoke ${STAMP} mustpay statutory-holiday overtime`,
  })
  ok(ot.res.status === 201 && ot.id, 'mustpay: statutory-holiday overtime request created', ot.res.body)
  if (!ot.id) throw new Error('mustpay overtime request creation failed')
  const approve = await approveRequest(ot.id)
  ok(approve.status === 200, 'mustpay: statutory-holiday overtime approved', approve.body)

  const lots = await lotsByRequest(ot.id)
  ok(lots.length === 0, 'mustpay: statutory-holiday OT banked NOTHING (never poolable; enabled bank fails closed to must-pay)', lots)

  await pool.query(
    `INSERT INTO attendance_leave_balances
       (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes, source_type, source_key, status, granted_at, overtime_source)
     VALUES ($1, $2, 'comp_time', 9999, 9999, 'overtime_conversion', $3, 'active', now(), 'statutory_holiday')`,
    [ORG_ID, USERS.mustpay, created.poisonLotKey],
  )
  ok(true, 'SQL-seeded poison statutory balance lot (9999m) — must never surface as must-pay or convertible', { poisonLotKey: created.poisonLotKey })
}

async function assertFullAttendanceFlags() {
  for (const plan of CASE_PLAN) {
    const res = await api(adminToken, `/api/attendance/summary?userId=${encodeURIComponent(USERS[plan.key])}&from=${smokeWindow.periodStart}&to=${smokeWindow.periodEnd}`)
    ok(
      res.status === 200 && res.body?.data?.fullAttendanceEligible === false,
      `${plan.key}: fullAttendanceEligible=false (any leave breaks it, even when pool-offset)`,
      { status: res.status, fullAttendanceEligible: res.body?.data?.fullAttendanceEligible },
    )
  }
  const control = await api(adminToken, `/api/attendance/summary?userId=${encodeURIComponent(USERS.dormant)}&from=${smokeWindow.periodStart}&to=${smokeWindow.periodEnd}`)
  ok(
    control.status === 200 && control.body?.data?.fullAttendanceEligible === true,
    'dormant (overtime-only, no leave) control: fullAttendanceEligible=true',
    { status: control.status, fullAttendanceEligible: control.body?.data?.fullAttendanceEligible },
  )
}

// Section-8a settlement population = period facts UNION active comp_time balance holders,
// org-wide. The balance arm is period-independent, so on a shared org a real staging user with
// an active comp_time balance would be enumerated into OUR smoke cycle's settlement snapshot.
// Fail closed unless the operator explicitly accepted that in the runbook decision block.
async function assertSettlementPopulationSynthetic() {
  const rows = await q(
    `SELECT count(*)::int AS non_synthetic FROM (
       SELECT user_id FROM attendance_records WHERE org_id = $1 AND work_date BETWEEN $2 AND $3
       UNION
       SELECT user_id FROM attendance_requests WHERE org_id = $1 AND status = 'approved' AND work_date BETWEEN $2 AND $3
       UNION
       SELECT user_id FROM attendance_leave_balances WHERE org_id = $1 AND leave_type_code = 'comp_time' AND status = 'active' AND remaining_minutes > 0
     ) pop WHERE user_id IS NULL OR left(user_id, $4) <> $5`,
    [ORG_ID, smokeWindow.periodStart, smokeWindow.periodEnd, USER_PREFIX.length, USER_PREFIX],
  )
  const nonSynthetic = Number(rows[0]?.non_synthetic ?? -1)
  populationSyntheticOnly = nonSynthetic === 0
  if (nonSynthetic > 0 && !ENTRY.config.allowNonSyntheticPopulation) {
    throw new Error(`cycle close would settle ${nonSynthetic} non-synthetic user(s) on org "${ORG_ID}" (active comp_time balance holders are enumerated period-independently). Use a dedicated smoke org per the runbook decision block, or set ALLOW_NON_SYNTHETIC_SETTLEMENT_POPULATION=1 (dangerous) after the operator explicitly accepts it.`)
  }
  ok(
    populationSyntheticOnly || ENTRY.config.allowNonSyntheticPopulation,
    `settlement population check (non-synthetic users: ${nonSynthetic}${populationSyntheticOnly ? '' : '; override accepted'})`,
    { nonSynthetic },
  )
}

async function assertCycleCloseSettlement() {
  const createRes = await api(adminToken, '/api/attendance/payroll-cycles', {
    method: 'POST',
    body: {
      name: created.cycleName,
      startDate: smokeWindow.periodStart,
      endDate: smokeWindow.periodEnd,
      status: 'open',
      metadata: { smokeStamp: STAMP },
    },
  })
  const cycleId = createRes.body?.data?.id ?? null
  ok(createRes.status === 201 && cycleId, 'created stamped OPEN payroll cycle over the smoke period', createRes.body)
  if (!cycleId) throw new Error('payroll cycle creation failed (an exact-period collision returns 409 ALREADY_EXISTS — rerun with SMOKE_YEAR)')
  created.cycleIds.push(String(cycleId))

  const pre = await settlementRows(cycleId)
  ok(pre.length === 0, 'no settlement rows exist before close', pre)

  const close = await api(adminToken, `/api/attendance/payroll-cycles/${cycleId}`, { method: 'PUT', body: { status: 'closed' } })
  ok(close.status === 200, 'cycle open→closed transition succeeded (snapshot in the same txn)', close.body)

  const rows = await settlementRows(cycleId)
  const forUser = (userId) => rows.filter(row => row.user_id === userId)

  ok(forUser(USERS.case1).length === 0, 'case1: pool fully consumed → no settlement row (convertible 0, must-pay 0)', settlementProjection(forUser(USERS.case1)))

  const c2 = forUser(USERS.case2)
  ok(
    c2.length === 1 && c2[0]?.source === 'workday' && Number(c2[0]?.convertible_minutes) === 300 && Number(c2[0]?.must_pay_minutes) === 0,
    'case2: exactly one workday row with convertible=300, must_pay=0',
    settlementProjection(c2),
  )
  ok(
    c2[0] != null
      && String(c2[0].period_start_date).slice(0, 10) === smokeWindow.periodStart
      && String(c2[0].period_end_date).slice(0, 10) === smokeWindow.periodEnd
      && c2[0].closed_at != null,
    'case2: settlement row carries the frozen period columns + closed_at',
    c2[0] && { period_start_date: c2[0].period_start_date, period_end_date: c2[0].period_end_date },
  )
  const snapshot = parseJson(c2[0]?.snapshot) ?? {}
  ok(
    Array.isArray(snapshot?.overtimeBankPolicy?.pooledSources) && snapshot.overtimeBankPolicy.pooledSources.includes('workday'),
    'case2: snapshot froze the effective overtimeBankPolicy (pooledSources includes workday)',
    snapshot?.overtimeBankPolicy,
  )

  ok(forUser(USERS.case3).length === 0, 'case3: partial offset exhausted the pool → no settlement row (convertible 0)', settlementProjection(forUser(USERS.case3)))

  const mp = forUser(USERS.mustpay)
  ok(
    mp.length === 1 && mp[0]?.source === 'statutory_holiday' && Number(mp[0]?.must_pay_minutes) === 480 && Number(mp[0]?.convertible_minutes) === 0,
    'mustpay: statutory must-pay=480 from PERIOD facts; poison 9999 balance lot did not surface',
    settlementProjection(mp),
  )

  const dm = forUser(USERS.dormant)
  ok(
    dm.length === 1 && dm[0]?.source === 'legacy_unsourced' && Number(dm[0]?.convertible_minutes) === 120 && Number(dm[0]?.must_pay_minutes) === 0,
    'dormant: NULL-source balance settles as legacy_unsourced convertible=120, must_pay=0',
    settlementProjection(dm),
  )

  if (populationSyntheticOnly) {
    ok(rows.length === 3, 'settlement rows are exactly the 3 expected (case2 + mustpay + dormant); zero-zero rows skipped', settlementProjection(rows))
  }

  const replay = await api(adminToken, `/api/attendance/payroll-cycles/${cycleId}`, { method: 'PUT', body: { status: 'closed' } })
  ok(replay.status === 200, 'replay close returns 200', replay.body)
  const replayRows = await settlementRows(cycleId)
  ok(
    replayRows.length === rows.length && stableJson(settlementProjection(replayRows)) === stableJson(settlementProjection(rows)),
    'replay close is idempotent — settlement rows unchanged (ON CONFLICT DO NOTHING)',
    settlementProjection(replayRows),
  )

  const frozen = await api(adminToken, `/api/attendance/payroll-cycles/${cycleId}`, {
    method: 'PUT',
    body: { startDate: addDays(smokeWindow.periodStart, 1), endDate: smokeWindow.periodEnd },
  })
  ok(frozen.status === 409 && frozen.body?.error?.code === 'CYCLE_CLOSED_PERIOD_FROZEN', 'closed cycle period change returns 409 CYCLE_CLOSED_PERIOD_FROZEN', frozen.body)

  const del = await api(adminToken, `/api/attendance/payroll-cycles/${cycleId}`, { method: 'DELETE' })
  ok(del.status === 409 && del.body?.error?.code === 'CYCLE_CLOSED_NOT_DELETABLE', 'closed cycle DELETE returns 409 CYCLE_CLOSED_NOT_DELETABLE (cleanup must use scoped SQL)', del.body)

  return cycleId
}

// --- cleanup / residue -----------------------------------------------------------------------

async function residueCounts() {
  const requestIds = created.requestIds
  const approvalIds = Array.from(created.approvalInstanceIds)
  const cycleIds = created.cycleIds
  const holidayIds = created.holidayIds
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_requests
         WHERE org_id = $1 AND (id = ANY($4::uuid[]) OR left(user_id, $2) = $3)) AS requests,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND left(user_id, $2) = $3) AS records,
       (SELECT count(*)::int FROM attendance_events
         WHERE org_id = $1 AND meta->>'requestId' = ANY($5::text[])) AS events,
       (SELECT count(*)::int FROM attendance_leave_balances
         WHERE org_id = $1 AND (left(user_id, $2) = $3 OR source_key = $6)) AS leave_balances,
       (SELECT count(*)::int FROM attendance_leave_balance_events
         WHERE org_id = $1 AND left(user_id, $2) = $3) AS balance_events,
       (SELECT count(*)::int FROM attendance_leave_types
         WHERE org_id = $1 AND (id = ANY($7::uuid[]) OR code = $8)) AS leave_types,
       (SELECT count(*)::int FROM attendance_overtime_rules
         WHERE org_id = $1 AND (id = ANY($9::uuid[]) OR name = $10)) AS overtime_rules,
       (SELECT count(*)::int FROM attendance_holidays
         WHERE org_id = $1 AND (id = ANY($11::uuid[]) OR name = $12)) AS holidays,
       (SELECT count(*)::int FROM attendance_payroll_cycle_settlements
         WHERE org_id = $1 AND cycle_id = ANY($13::uuid[])) AS settlements,
       (SELECT count(*)::int FROM attendance_payroll_cycles
         WHERE org_id = $1 AND (id = ANY($13::uuid[]) OR metadata->>'smokeStamp' = $14)) AS cycles,
       (SELECT count(*)::int FROM approval_instances WHERE id = ANY($15::text[])) AS approval_instances,
       (SELECT count(*)::int FROM approval_assignments WHERE instance_id = ANY($15::text[])) AS approval_assignments,
       (SELECT count(*)::int FROM approval_records WHERE instance_id = ANY($15::text[])) AS approval_records,
       (SELECT count(*)::int FROM attendance_notification_deliveries
         WHERE org_id = $1 AND left(recipient_user_id, $2) = $3) AS deliveries,
       (SELECT count(*)::int FROM user_orgs WHERE org_id = $1 AND left(user_id, $2) = $3) AS user_orgs,
       (SELECT count(*)::int FROM users WHERE left(id, $2) = $3) AS users`,
    [
      ORG_ID,
      USER_PREFIX.length,
      USER_PREFIX,
      requestIds,
      requestIds,
      created.poisonLotKey,
      created.leaveTypeId ? [created.leaveTypeId] : [],
      created.leaveTypeCode,
      created.overtimeRuleId ? [created.overtimeRuleId] : [],
      created.overtimeRuleName,
      holidayIds,
      created.holidayName,
      cycleIds,
      STAMP,
      approvalIds,
    ],
  ))[0] || {}
  return row
}

async function restoreSettings({ strict = false } = {}) {
  if (!originalSettings) return
  const res = await api(adminToken, '/api/attendance/settings', { method: 'PUT', body: buildRestoreSettingsBody(originalSettings) })
  if (strict) {
    ok(res.status === 200, `restore original attendance settings (status ${res.status})`, res.body)
    if (res.status !== 200) throw new Error('failed to restore original attendance settings')
    const restored = await getSettings()
    for (const key of RESTORED_POLICY_KEYS) {
      const restoredPolicy = restored[key] ?? null
      const originalPolicy = originalSettings[key] ?? null
      ok(stableJson(restoredPolicy) === stableJson(originalPolicy), `restored ${key} matches the pre-smoke value`, restoredPolicy)
      if (stableJson(restoredPolicy) !== stableJson(originalPolicy)) {
        throw new Error(`${key} did not restore to its pre-smoke value`)
      }
    }
    return
  }
  if (res.status !== 200) {
    console.error(`WARN: failed to restore attendance settings (status ${res.status})`)
  }
}

async function cleanup({ strictSettingsRestore = false } = {}) {
  if (!cleanupAllowed) return
  await restoreSettings({ strict: strictSettingsRestore }).catch(error => {
    if (strictSettingsRestore) throw error
    console.error(`WARN: failed to restore attendance settings: ${error?.message || error}`)
  })
  const requestIds = created.requestIds
  const approvalIds = Array.from(created.approvalInstanceIds)
  const cycleIds = created.cycleIds
  const holidayIds = created.holidayIds
  // FK-safe order: approval children → events → records → requests → lots (balance events
  // cascade) → approval instances → settlements (FK RESTRICT) → cycles → fixtures → users.
  await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds]).catch(() => undefined)
  await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds]).catch(() => undefined)
  await pool.query(`DELETE FROM attendance_events WHERE org_id = $1 AND meta->>'requestId' = ANY($2::text[])`, [ORG_ID, requestIds]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_records WHERE org_id = $1 AND left(user_id, $2) = $3', [ORG_ID, USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_requests WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR left(user_id, $3) = $4)', [ORG_ID, requestIds, USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_leave_balances WHERE org_id = $1 AND (left(user_id, $2) = $3 OR source_key = $4)', [ORG_ID, USER_PREFIX.length, USER_PREFIX, created.poisonLotKey]).catch(() => undefined)
  await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_payroll_cycle_settlements WHERE org_id = $1 AND cycle_id = ANY($2::uuid[])', [ORG_ID, cycleIds]).catch(() => undefined)
  await pool.query(`DELETE FROM attendance_payroll_cycles WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR metadata->>'smokeStamp' = $3)`, [ORG_ID, cycleIds, STAMP]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_holidays WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR name = $3)', [ORG_ID, holidayIds, created.holidayName]).catch(() => undefined)
  if (created.overtimeRuleId) {
    await pool.query('DELETE FROM attendance_overtime_rules WHERE org_id = $1 AND id = $2', [ORG_ID, created.overtimeRuleId]).catch(() => undefined)
  }
  if (created.leaveTypeId) {
    await pool.query('DELETE FROM attendance_leave_types WHERE org_id = $1 AND id = $2', [ORG_ID, created.leaveTypeId]).catch(() => undefined)
  }
  await pool.query('DELETE FROM user_orgs WHERE org_id = $1 AND left(user_id, $2) = $3', [ORG_ID, USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
  await pool.query('DELETE FROM users WHERE left(id, $1) = $2', [USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  console.log(`OT-bank v1-8 API/DB staging smoke helper @ ${BASE_URL}`)
  console.log(`  deploy=${DEPLOY_SHA} org=${ORG_ID} stamp=${STAMP}`)
  console.log('  NOTE: this helper does not close v1-8 by itself; record the final stamp only through the v1-8 runbook after its operator-decision blocks are resolved.')

  await resolveTokens()
  await preflightDatabase()
  await preflightNoExistingResidue()
  originalSettings = await getSettings()

  smokeWindow = await chooseWindow()
  await seedUsers()
  await setupFixtures()

  await assertDormantGrantRegression()
  await enableBankAndOffsetPolicies()
  for (const plan of CASE_PLAN) {
    await runOwnerCase(plan)
  }
  await assertStatutoryMustPaySetup()
  await assertFullAttendanceFlags()
  await assertSettlementPopulationSynthetic()
  const cycleId = await assertCycleCloseSettlement()

  await cleanup({ strictSettingsRestore: true })
  const residue = await residueCounts()
  const residueOk = Object.values(residue).every(value => Number(value) === 0)
  ok(residueOk, 'cleanup residue is zero', residue)
  if (!residueOk) throw new Error(`residue not zero: ${JSON.stringify(residue)}`)
  if (failures.length) {
    throw new Error(`OT-bank v1-8 API/DB smoke had ${failures.length} failed assertion(s): ${failures.join('; ')}`)
  }

  console.log(`OTBANK_V18_API_DB_SMOKE_PASS deploy=${DEPLOY_SHA} stamp=${STAMP} org=${ORG_ID} cycle=${cycleId} residue=0`)
  console.log(`Assertions passed: ${pass}`)
}

if (IS_MAIN) {
  let pg
  try {
    pg = await import('pg')
  } catch {
    console.error('FAIL: package "pg" is required. Run this helper from a prepared metasheet2 checkout with dependencies installed.')
    process.exit(2)
  }
  pool = new pg.default.Pool({ connectionString: DATABASE_URL })
  main()
    .catch(async (error) => {
      console.error(`FAIL: ${error?.message || error}`)
      try {
        await cleanup()
        const residue = await residueCounts()
        console.error(`Residue after best-effort cleanup: ${JSON.stringify(residue)}`)
      } catch (cleanupError) {
        console.error(`WARN: cleanup failed: ${cleanupError?.message || cleanupError}`)
      }
      process.exitCode = 1
    })
    .finally(async () => {
      await pool.end().catch(() => undefined)
    })
}
