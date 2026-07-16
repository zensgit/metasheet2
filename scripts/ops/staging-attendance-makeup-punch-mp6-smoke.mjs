#!/usr/bin/env node
// MP-6 makeup-punch staging smoke helper — quota / window / type / anomaly-prefill /
// approval-adjusted-record / residue chain for the 补卡规则 (makeup-punch policy).
//
// This helper drives the real staging HTTP API for every business write (settings PUT to
// enable makeupPunchPolicy, request create, approve) and uses SQL only for synthetic seed
// (users + partial attendance_records that materialize the SERVER-derived anomaly facts that
// `deriveMakeupAnomalyFacts` reads — never client anomaly prefill), exact assertions (request
// metadata snapshot + adjustment event meta have no API read surface), and stamped cleanup. It
// intentionally does NOT claim the final MP-6 staging closeout; the operator-decision blocks and
// the final stamp live in
// docs/development/attendance-makeup-punch-mp6-staging-smoke-runbook-20260703.md.
//
// Grounding (all on origin/main in plugins/plugin-attendance/index.cjs):
//   DEFAULT_SETTINGS.makeupPunchPolicy L284; MAKEUP_PUNCH_ALLOWED_REQUEST_TYPES L12650;
//   MAKEUP_REQUEST_TYPE_ANOMALY_TABLE L12727; deriveMakeupAnomalyFacts L12739;
//   buildMakeupPunchPolicySnapshot L12812; enforceMakeupPunchPolicy L12843 (order: future L12851 →
//   window L12857 → type L12862 → reason L12872 → attachment L12875 → quota L12881); POST enforce
//   wiring L26736-26782; final-approval adjusted record L28441-28459 (mode:'override',
//   statusOverride:'adjusted'); adjustment event + reduced meta.makeupPolicySnapshot L28546-28600
//   (gated on snapshot PRESENCE L28561).
//
// Cases (one synthetic subject, quota cap = 1):
//   reject: FUTURE_DATE_UNSUPPORTED (workDate = today+2, throws before type gate — no seed)
//   reject: WINDOW_EXPIRED         (workDate = today-45, older than submitWindow.days=30)
//   reject: TYPE_NOT_ALLOWED       (missed_check_IN against a missing_check_out fact)
//   reject: REASON_REQUIRED        (valid fact, empty reason)
//   reject: ATTACHMENT_REQUIRED    (valid fact, reason present, no attachmentUrl)
//   valid : missed_check_out against a seeded partial record → pending + full snapshot
//   quota : a second same-cycle valid makeup → QUOTA_EXCEEDED (the pending valid fills the 1 slot)
//   approve: the valid request → adjusted record + adjustment event carrying the REDUCED snapshot
//   residue: stamped cleanup over every dirtied table, residue=0, zero deliveries.

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// --- pure helpers (exported for the companion .test.mjs) -----------------------------------

export const STAMP_PATTERN = /^mp6-smoke-[A-Za-z0-9-]+$/

// Only makeupPunchPolicy is toggled; PUT /api/attendance/settings deep-merges per policy key, so
// the restore re-asserts the whole normalized policy (see buildRestoreSettingsBody).
export const RESTORED_POLICY_KEYS = ['makeupPunchPolicy']

// The smoke policy: quota cap 1 makes the quota probe deterministic (one pending fills the slot);
// requireAttachment true so the ATTACHMENT_REQUIRED code is provable (valid/quota carry a stamped
// attachmentUrl to pass it). allowedAnomalyTypes keeps the design preset.
export const SMOKE_TIMEZONE = 'Asia/Shanghai'
export const SMOKE_MAX_REQUESTS = 1
export const SMOKE_WINDOW_DAYS = 30

export function buildEnabledMakeupPolicy() {
  return {
    enabled: true,
    timezone: SMOKE_TIMEZONE,
    cycle: { type: 'calendar_month', startDay: 1 },
    quota: {
      maxRequestsPerCycle: SMOKE_MAX_REQUESTS,
      countStatuses: ['pending', 'approved'],
      principal: 'self_service_user',
    },
    submitWindow: { unit: 'calendar_day', days: SMOKE_WINDOW_DAYS },
    allowedAnomalyTypes: ['missing_check_in', 'missing_check_out', 'late', 'severe_late', 'absence_late', 'early_leave'],
    allowedRequestTypes: ['missed_check_in', 'missed_check_out', 'time_correction'],
    requireReason: true,
    requireAttachment: true,
  }
}

// The six enforcement codes MP-6 proves, in the order enforceMakeupPunchPolicy checks them
// (future → window → type → reason → attachment → quota). Reference table for the .test.mjs.
export const MAKEUP_PUNCH_CODES = Object.freeze([
  'MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED',
  'MAKEUP_PUNCH_WINDOW_EXPIRED',
  'MAKEUP_PUNCH_TYPE_NOT_ALLOWED',
  'MAKEUP_PUNCH_REASON_REQUIRED',
  'MAKEUP_PUNCH_ATTACHMENT_REQUIRED',
  'MAKEUP_PUNCH_QUOTA_EXCEEDED',
])

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

export function parseJson(value) {
  if (value == null || typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

export function isStampedId(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length
}

export function addDaysToDateKey(ymd, days) {
  const next = new Date(`${ymd}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

export function dayOfMonth(ymd) {
  return Number(String(ymd).slice(8, 10))
}

export function sameCalendarMonth(a, b) {
  return String(a).slice(0, 7) === String(b).slice(0, 7)
}

// Resolve "today" in the policy timezone (server enforce anchors workDate on policy-tz local date,
// see toWorkDate at enforce L12848). en-CA yields YYYY-MM-DD.
export function todayLocalKey(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

// Deterministic date plan from a policy-tz "today". The VALID + QUOTA dates MUST share one
// calendar_month cycle (startDay=1) because the quota count is per-(org,subject,cycle) — anchored
// on workDate, not submit time. All valid/reject-at-type dates are past and inside submitWindow.days;
// FUTURE and WINDOW dates sit safely outside on either side (±-day margins absorb midnight drift).
export function pickMakeupDates(todayKey, { windowDays = SMOKE_WINDOW_DAYS } = {}) {
  // quotaDate: 2 days ago, nudged off a day-1 boundary so validDate (quotaDate-1) stays same-month.
  let quotaDate = addDaysToDateKey(todayKey, -2)
  if (dayOfMonth(quotaDate) < 2) quotaDate = addDaysToDateKey(quotaDate, -1)
  const validDate = addDaysToDateKey(quotaDate, -1)
  // reject-at-type dates: only need past + within window; cycle membership is irrelevant (they roll back).
  const typeDate = addDaysToDateKey(validDate, -1)
  const reasonDate = addDaysToDateKey(validDate, -2)
  const attachDate = addDaysToDateKey(validDate, -3)
  const futureDate = addDaysToDateKey(todayKey, 2)
  const windowExpiredDate = addDaysToDateKey(todayKey, -(windowDays + 15))
  return { validDate, quotaDate, typeDate, reasonDate, attachDate, futureDate, windowExpiredDate }
}

// PUT /api/attendance/settings deep-merges per policy key (mergeSettings, index.cjs ~L13116), so a
// restore that PUTs an empty/partial snapshot is a NO-OP that leaks this smoke's enabled policy.
// getSettings returns the FULLY-NORMALIZED makeupPunchPolicy (normalizeMakeupPunchPolicySetting fills
// every nested field from DEFAULT), so spreading the pre-smoke policy restores every field exactly;
// the `enabled: false` floor only guards the impossible case where the key is absent.
export function buildRestoreSettingsBody(originalSettings) {
  const original = originalSettings && typeof originalSettings === 'object' ? originalSettings : {}
  return {
    ...original,
    makeupPunchPolicy: {
      enabled: false,
      ...(original.makeupPunchPolicy ?? {}),
    },
  }
}

// Env-only contract (no CLI args), mirroring the OT-bank v1-8 helper: BASE_URL/DATABASE_URL required,
// DEPLOY_SHA mandatory (the PASS stamp must name the staging build actually smoked), STAMP regex-locked
// so cleanup stays visibly synthetic and LIKE-free.
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
  const stamp = String(env.STAMP || `mp6-smoke-${suffix}`)
  if (!STAMP_PATTERN.test(stamp)) {
    errors.push('STAMP must match /^mp6-smoke-[A-Za-z0-9-]+$/ so cleanup remains visibly synthetic and LIKE-free.')
  }
  return {
    ok: errors.length === 0,
    errors,
    config: { baseUrl, databaseUrl, orgId, deploySha, stamp, suffix },
  }
}

// --- runtime wiring -------------------------------------------------------------------------

const IS_MAIN = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
const ENTRY = resolveEnvConfig(process.env)
if (IS_MAIN && !ENTRY.ok) {
  for (const message of ENTRY.errors) console.error(`FAIL: ${message}`)
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet DEPLOY_SHA=<deployed-sha> ADMIN_TOKEN=<jwt> SUBJECT_TOKEN=<jwt> node scripts/ops/staging-attendance-makeup-punch-mp6-smoke.mjs')
  process.exit(2)
}

const { baseUrl: BASE_URL, databaseUrl: DATABASE_URL, orgId: ORG_ID, deploySha: DEPLOY_SHA, stamp: STAMP } = ENTRY.config
const USER_PREFIX = `${STAMP}-`
const KEY_PREFIX = `mp6-smoke:${STAMP}:`

const USERS = {
  admin: process.env.ADMIN_USER_ID || `${USER_PREFIX}admin`,
  subject: process.env.SUBJECT_USER_ID || `${USER_PREFIX}subject`,
}
const ATTACHMENT_URL = `${KEY_PREFIX}attachment`

let adminToken = process.env.ADMIN_TOKEN || process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let subjectToken = process.env.SUBJECT_TOKEN || ''
let originalSettings = null
let cleanupAllowed = false
let dates = null
let pass = 0
const failures = []

const created = {
  requestIds: [],
  approvalInstanceIds: new Set(),
  validRequestId: null,
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
  const headers = { 'Content-Type': 'application/json', 'x-org-id': ORG_ID }
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
    throw new Error(`could not mint dev-token for ${userId} (status ${res.status}); provide explicit ADMIN_TOKEN/SUBJECT_TOKEN for staging environments that 404 the dev-token route (production node-env)`)
  }
  return token
}

async function resolveTokens() {
  assertSyntheticUser(USERS.admin, 'ADMIN_USER_ID')
  assertSyntheticUser(USERS.subject, 'SUBJECT_USER_ID')
  if (!adminToken) {
    adminToken = await mintToken(USERS.admin, { roles: 'admin', perms: 'attendance:read,attendance:write,attendance:admin,attendance:approve' })
    console.log('  minted admin dev-token')
  } else {
    const subject = jwtSubject(adminToken)
    if (subject != null) console.log(`  using supplied admin token (subject ${subject})`)
  }
  if (subjectToken) {
    // Requests are created AS the token subject; a mismatched supplied token would attribute the
    // makeup request to a user this smoke does not clean up.
    const subject = jwtSubject(subjectToken)
    if (subject !== USERS.subject) {
      throw new Error(`SUBJECT_TOKEN subject "${subject}" does not equal subject user id "${USERS.subject}"`)
    }
    console.log(`  using supplied subject token (subject ${subject})`)
  } else {
    subjectToken = await mintToken(USERS.subject, { roles: 'user', perms: 'attendance:read,attendance:write' })
    console.log('  minted subject dev-token')
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
       to_regclass('public.attendance_notification_deliveries') IS NOT NULL AS deliveries_ok,
       to_regclass('public.approval_instances') IS NOT NULL AS approval_instances_ok,
       to_regclass('public.approval_assignments') IS NOT NULL AS approval_assignments_ok,
       to_regclass('public.approval_records') IS NOT NULL AS approval_records_ok,
       to_regclass('public.system_configs') IS NOT NULL AS settings_ok`,
  ))[0] || {}
  const ready = Object.values(row).every(value => value === true)
  ok(ready, 'DB assertion channel reachable and makeup-punch tables exist', row)
  if (!ready) throw new Error('staging DB missing tables the MP-6 smoke needs, or DATABASE_URL points at the wrong database')
}

async function preflightNoExistingResidue() {
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM users WHERE left(id, $2) = $3) AS users,
       (SELECT count(*)::int FROM user_orgs WHERE org_id = $1 AND left(user_id, $2) = $3) AS user_orgs,
       (SELECT count(*)::int FROM attendance_requests WHERE org_id = $1 AND left(user_id, $2) = $3) AS requests,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND left(user_id, $2) = $3) AS records`,
    [ORG_ID, USER_PREFIX.length, USER_PREFIX],
  ))[0] || {}
  const clean = Object.values(row).every(value => Number(value) === 0)
  ok(clean, 'no pre-existing residue for this MP-6 smoke stamp', row)
  if (!clean) throw new Error(`pre-existing residue found for ${STAMP}; use a fresh STAMP or inspect before running`)
}

async function getSettings() {
  const res = await api(adminToken, '/api/attendance/settings')
  ok(res.status === 200, `GET settings through staging API (status ${res.status})`, res.body)
  if (res.status !== 200) throw new Error('cannot read attendance settings')
  return res.body?.data ?? {}
}

async function enableMakeupPolicy() {
  const res = await api(adminToken, '/api/attendance/settings', { method: 'PUT', body: { makeupPunchPolicy: buildEnabledMakeupPolicy() } })
  ok(res.status === 200, `enable makeupPunchPolicy (quota=${SMOKE_MAX_REQUESTS}, window=${SMOKE_WINDOW_DAYS}d) (status ${res.status})`, res.body)
  if (res.status !== 200) throw new Error('failed to enable makeupPunchPolicy')
}

async function verifySettingsCoherence() {
  const row = (await q(
    `SELECT value::jsonb #> '{makeupPunchPolicy,enabled}' AS enabled
     FROM system_configs
     WHERE key = 'attendance.settings'
     LIMIT 1`,
  ))[0]
  const enabled = row?.enabled
  ok(enabled === true, 'API settings write is visible through DATABASE_URL (makeupPunchPolicy.enabled=true)', row)
  if (enabled !== true) throw new Error('BASE_URL and DATABASE_URL do not appear coherent for attendance settings')
}

function assertWindow() {
  const d = dates
  const today = todayLocalKey(SMOKE_TIMEZONE)
  const withinWindow = (key) => today > key && addDaysToDateKey(today, -SMOKE_WINDOW_DAYS) <= key
  ok(sameCalendarMonth(d.validDate, d.quotaDate), 'valid + quota dates share one calendar_month cycle (quota is per-cycle)', d)
  ok(d.quotaDate === addDaysToDateKey(d.validDate, 1), 'quotaDate is the day after validDate', d)
  ok([d.validDate, d.quotaDate, d.typeDate, d.reasonDate, d.attachDate].every(withinWindow), 'all makeup work dates are past and inside the submit window', d)
  ok(d.futureDate > today, 'futureDate is strictly in the future', { today, futureDate: d.futureDate })
  ok(addDaysToDateKey(today, -SMOKE_WINDOW_DAYS) > d.windowExpiredDate, 'windowExpiredDate is older than the submit window', { today, windowExpiredDate: d.windowExpiredDate })
}

async function seedUsers() {
  const userId = USERS.subject
  assertSyntheticUser(userId, 'subject user')
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
  cleanupAllowed = true
  ok(true, 'seeded synthetic subject user + org membership', { stamp: STAMP })
}

// Seed a `partial` attendance_record (one side punched): first_in_at present, last_out_at NULL →
// deriveMakeupAnomalyFacts (L12758-12760) yields exactly ['missing_check_out']. This materializes
// SERVER truth so the type gate reads a real fact — not client anomaly prefill.
async function seedPartialRecord(workDate, label) {
  await pool.query(
    `INSERT INTO attendance_records
       (user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, updated_at)
     VALUES ($1, $2, $3, $4, $5, NULL, 0, 0, 0, 'partial', true, $6::jsonb, now())
     ON CONFLICT (user_id, work_date, org_id)
     DO UPDATE SET status = 'partial', first_in_at = EXCLUDED.first_in_at, last_out_at = NULL, meta = EXCLUDED.meta, updated_at = now()`,
    [USERS.subject, ORG_ID, workDate, SMOKE_TIMEZONE, `${workDate}T01:00:00.000Z`, JSON.stringify({ smokeStamp: STAMP, seed: label })],
  )
}

async function seedAnomalies() {
  await seedPartialRecord(dates.validDate, 'valid')
  await seedPartialRecord(dates.quotaDate, 'quota')
  await seedPartialRecord(dates.typeDate, 'type')
  await seedPartialRecord(dates.reasonDate, 'reason')
  await seedPartialRecord(dates.attachDate, 'attachment')
  ok(true, 'seeded 5 synthetic partial records (missing_check_out fact) for the subject', { dates })
}

async function captureApprovalInstanceId(requestId) {
  const rows = await q('SELECT approval_instance_id FROM attendance_requests WHERE id = $1 AND org_id = $2', [requestId, ORG_ID])
  const approvalId = rows[0]?.approval_instance_id
  if (approvalId) created.approvalInstanceIds.add(String(approvalId))
}

async function postRequest(body) {
  const res = await api(subjectToken, '/api/attendance/requests', { method: 'POST', body: { orgId: ORG_ID, ...body } })
  const id = res.body?.data?.request?.id ?? null
  if (id) {
    created.requestIds.push(String(id))
    await captureApprovalInstanceId(id)
  }
  return { res, id }
}

function makeupBody(workDate, requestType, { reason, attachment = true } = {}) {
  const body = {
    workDate,
    requestType,
    reason: reason === undefined ? `MP-6 smoke ${STAMP} ${requestType} ${workDate}` : reason,
    // The server's draft resolver reads the attachment from the TOP-LEVEL body field
    // (parsedData.attachmentUrl) and rebuilds metadata from scratch — a body.metadata
    // attachment is silently dropped (run 29383604023: valid leg 422
    // MAKEUP_PUNCH_ATTACHMENT_REQUIRED despite metadata.attachmentUrl being set).
    ...(attachment ? { attachmentUrl: ATTACHMENT_URL } : {}),
  }
  if (requestType === 'missed_check_in') body.requestedInAt = `${workDate}T01:00:00.000Z`
  else body.requestedOutAt = `${workDate}T10:00:00.000Z`
  return body
}

async function expectRejection(body, expectedCode, label) {
  const { res, id } = await postRequest(body)
  ok(res.status === 422 && res.body?.error?.code === expectedCode, `${label} → 422 ${expectedCode}`, { status: res.status, code: res.body?.error?.code })
  if (id) throw new Error(`${label}: a rejected makeup request unexpectedly created request row ${id}`)
}

async function approveRequest(requestId) {
  return api(adminToken, `/api/attendance/requests/${requestId}/approve`, {
    method: 'POST',
    body: { comment: `MP-6 smoke ${STAMP} approve` },
  })
}

// --- phases ----------------------------------------------------------------------------------

async function runRejectionCases() {
  // FUTURE and WINDOW throw before the type gate (no seed needed); the rest need a seeded fact.
  await expectRejection(makeupBody(dates.futureDate, 'missed_check_out'), 'MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED', 'future workDate')
  await expectRejection(makeupBody(dates.windowExpiredDate, 'missed_check_out'), 'MAKEUP_PUNCH_WINDOW_EXPIRED', 'expired-window workDate')
  await expectRejection(makeupBody(dates.typeDate, 'missed_check_in'), 'MAKEUP_PUNCH_TYPE_NOT_ALLOWED', 'missed_check_in against a missing_check_out fact')
  await expectRejection(makeupBody(dates.reasonDate, 'missed_check_out', { reason: '' }), 'MAKEUP_PUNCH_REASON_REQUIRED', 'empty reason')
  await expectRejection(makeupBody(dates.attachDate, 'missed_check_out', { attachment: false }), 'MAKEUP_PUNCH_ATTACHMENT_REQUIRED', 'missing attachment')
}

function assertFullSnapshot(snapshot) {
  const okShape = snapshot
    && snapshot.version === 1
    && snapshot.enabled === true
    && snapshot.timezone === SMOKE_TIMEZONE
    && snapshot.cycle?.type === 'calendar_month'
    && snapshot.cycle?.startDay === 1
    && Number(snapshot.quota?.maxRequestsPerCycle) === SMOKE_MAX_REQUESTS
    && Array.isArray(snapshot.quota?.countStatuses)
    && snapshot.quota?.principal === 'self_service_user'
    && snapshot.submitWindow?.unit === 'calendar_day'
    && Number(snapshot.submitWindow?.days) === SMOKE_WINDOW_DAYS
    && Array.isArray(snapshot.allowedAnomalyTypes)
    && typeof snapshot.requestEvaluatedAt === 'string'
    && Array.isArray(snapshot.matchedAnomalyTypes)
    && snapshot.matchedAnomalyTypes.includes('missing_check_out')
  ok(Boolean(okShape), 'valid request: metadata.makeupPunchPolicySnapshot carries the FULL snapshot (matched=missing_check_out)', snapshot)
}

async function runValidAndQuota() {
  // VALID (anomaly-prefill accepted): created pending with a fresh full snapshot on the metadata.
  const valid = await postRequest(makeupBody(dates.validDate, 'missed_check_out'))
  ok(valid.res.status === 201 && valid.id, `valid missed_check_out created pending (status ${valid.res.status})`, valid.res.body)
  if (!valid.id) throw new Error('valid makeup request creation failed')
  created.validRequestId = valid.id

  const metaRows = await q('SELECT status, metadata FROM attendance_requests WHERE id = $1 AND org_id = $2', [valid.id, ORG_ID])
  ok(metaRows[0]?.status === 'pending', 'valid request row is status=pending before approval', metaRows[0]?.status)
  const snapshot = (parseJson(metaRows[0]?.metadata) ?? {}).makeupPunchPolicySnapshot ?? null
  assertFullSnapshot(snapshot)

  // QUOTA: a second same-cycle valid makeup — the pending valid fills the cap of 1 → rejected.
  await expectRejection(makeupBody(dates.quotaDate, 'missed_check_out'), 'MAKEUP_PUNCH_QUOTA_EXCEEDED', 'second same-cycle makeup')

  // Every reject rolled back: exactly the one pending valid row remains for the subject.
  const countRows = await q('SELECT count(*)::int AS total FROM attendance_requests WHERE org_id = $1 AND left(user_id, $2) = $3', [ORG_ID, USER_PREFIX.length, USER_PREFIX])
  ok(Number(countRows[0]?.total) === 1, 'exactly one subject request row exists (all rejections rolled back)', countRows[0])
}

async function runApprovalAdjustedRecord() {
  const approve = await approveRequest(created.validRequestId)
  ok(approve.status === 200, `valid request approved (status ${approve.status})`, approve.body)

  const reqRows = await q('SELECT status FROM attendance_requests WHERE id = $1 AND org_id = $2', [created.validRequestId, ORG_ID])
  ok(reqRows[0]?.status === 'approved', 'approved request row is status=approved', reqRows[0]?.status)

  const recordRows = await q('SELECT status FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3', [ORG_ID, USERS.subject, dates.validDate])
  ok(recordRows[0]?.status === 'adjusted', 'attendance_record for the valid work date is status=adjusted (makeup applied)', recordRows[0]?.status)

  const eventRows = await q(
    `SELECT meta FROM attendance_events
     WHERE org_id = $1 AND event_type = 'adjustment' AND meta->>'requestId' = $2`,
    [ORG_ID, created.validRequestId],
  )
  ok(eventRows.length === 1, 'exactly one adjustment event exists for the approved makeup request', { count: eventRows.length })
  const eventMeta = parseJson(eventRows[0]?.meta) ?? {}
  const snap = eventMeta.makeupPolicySnapshot ?? null
  // The event meta carries the REDUCED snapshot (L28568-28580): quota is { maxRequestsPerCycle } ONLY.
  const reducedOk = snap
    && snap.version === 1
    && snap.enabled === true
    && Number(snap.quota?.maxRequestsPerCycle) === SMOKE_MAX_REQUESTS
    && snap.quota?.countStatuses === undefined
    && snap.quota?.principal === undefined
    && Array.isArray(snap.matchedAnomalyTypes)
    && snap.matchedAnomalyTypes.includes('missing_check_out')
    && typeof snap.requestEvaluatedAt === 'string'
  ok(Boolean(reducedOk), 'adjustment event meta carries the REDUCED makeupPolicySnapshot (quota=maxRequestsPerCycle only)', snap)
}

// --- cleanup / residue -----------------------------------------------------------------------

async function residueCounts() {
  const requestIds = created.requestIds
  const approvalIds = Array.from(created.approvalInstanceIds)
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_requests
         WHERE org_id = $1 AND (id = ANY($4::uuid[]) OR left(user_id, $2) = $3)) AS requests,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND left(user_id, $2) = $3) AS records,
       (SELECT count(*)::int FROM attendance_events
         WHERE org_id = $1 AND meta->>'requestId' = ANY($5::text[])) AS events,
       (SELECT count(*)::int FROM approval_instances WHERE id = ANY($6::text[])) AS approval_instances,
       (SELECT count(*)::int FROM approval_assignments WHERE instance_id = ANY($6::text[])) AS approval_assignments,
       (SELECT count(*)::int FROM approval_records WHERE instance_id = ANY($6::text[])) AS approval_records,
       (SELECT count(*)::int FROM attendance_notification_deliveries
         WHERE org_id = $1 AND left(recipient_user_id, $2) = $3) AS deliveries,
       (SELECT count(*)::int FROM user_orgs WHERE org_id = $1 AND left(user_id, $2) = $3) AS user_orgs,
       (SELECT count(*)::int FROM users WHERE left(id, $2) = $3) AS users`,
    [ORG_ID, USER_PREFIX.length, USER_PREFIX, requestIds, requestIds, approvalIds],
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
  // FK-safe order: approval children → adjustment events → records → requests (which FK
  // approval_instance_id) → approval instances → user_orgs (FK users) → users. Deliveries are never
  // written by this smoke, so they are asserted zero but never deleted.
  await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds]).catch(() => undefined)
  await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds]).catch(() => undefined)
  await pool.query(`DELETE FROM attendance_events WHERE org_id = $1 AND meta->>'requestId' = ANY($2::text[])`, [ORG_ID, requestIds]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_records WHERE org_id = $1 AND left(user_id, $2) = $3', [ORG_ID, USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_requests WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR left(user_id, $3) = $4)', [ORG_ID, requestIds, USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
  await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds]).catch(() => undefined)
  await pool.query('DELETE FROM user_orgs WHERE org_id = $1 AND left(user_id, $2) = $3', [ORG_ID, USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
  await pool.query('DELETE FROM users WHERE left(id, $1) = $2', [USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  console.log(`MP-6 makeup-punch API/DB staging smoke helper @ ${BASE_URL}`)
  console.log(`  deploy=${DEPLOY_SHA} org=${ORG_ID} stamp=${STAMP}`)
  console.log('  NOTE: this helper does not close MP-6 by itself; record the final stamp only through the MP-6 runbook after its operator-decision blocks are resolved.')

  await resolveTokens()
  await preflightDatabase()
  await preflightNoExistingResidue()
  originalSettings = await getSettings()

  const today = todayLocalKey(SMOKE_TIMEZONE)
  dates = pickMakeupDates(today)
  console.log(`  policy-tz today=${today} (${SMOKE_TIMEZONE})`)
  assertWindow()

  await seedUsers()
  await enableMakeupPolicy()
  await verifySettingsCoherence()
  await seedAnomalies()

  await runRejectionCases()
  await runValidAndQuota()
  await runApprovalAdjustedRecord()

  await cleanup({ strictSettingsRestore: true })
  const residue = await residueCounts()
  const residueOk = Object.values(residue).every(value => Number(value) === 0)
  ok(residueOk, 'cleanup residue is zero (incl zero notification deliveries)', residue)
  if (!residueOk) throw new Error(`residue not zero: ${JSON.stringify(residue)}`)
  if (failures.length) {
    throw new Error(`MP-6 makeup-punch API/DB smoke had ${failures.length} failed assertion(s): ${failures.join('; ')}`)
  }

  console.log(`MP6_MAKEUP_PUNCH_API_DB_SMOKE_PASS deploy=${DEPLOY_SHA} stamp=${STAMP} org=${ORG_ID} quota=${SMOKE_MAX_REQUESTS} approvals=1 residue=0`)
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
