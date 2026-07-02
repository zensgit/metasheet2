#!/usr/bin/env node
// RD-4/5 staging smoke helper — attendance report-digest producer / worker send chain.
//
// Two trigger tracks (see docs/development/attendance-rd45-report-digest-staging-smoke-runbook-20260702.md):
//   TRIGGER_MODE=seam      (PRIMARY, default) — in-process invocation of the shipped
//     __attendanceReportDigestForTests.runAttendanceReportDigestOnce seam (C5-5 precedent) against a
//     DISPOSABLE SINGLE-MEMBER smoke org. This is the only track that can honor the window plan's
//     "RD-4/5 MUST use a disposable single-member smoke org" rule, because the backend scheduler job
//     passes no orgId and is hardwired to the default org. Deterministic: no scheduler wait, todayKey
//     pinned, and the producer env gate is set in THIS process only — the backend's
//     ATTENDANCE_REPORT_DIGEST_ENABLED must stay unset/false so the globally-shared policy this smoke
//     enables cannot fan out to real default-org members (the helper asserts no default-org leakage).
//   TRIGGER_MODE=scheduler (OPTIONAL VARIANT, owner-gated) — real backend scheduler tick on org
//     'default'. Requires ACK_DEFAULT_ORG_FANOUT=1 because it writes pending digest rows naming EVERY
//     active default-org member, and requires the delivery worker env gate to be unset/false on the
//     backend (rows must stay 'pending'; nothing may send to real staging users).
//
// KNOWN FAMILY DEVIATION (loud, not silent): digest source_keys are DETERMINISTIC
// (org/cadence/period/subject/recipient/channel) and carry NO rd45 stamp. Residue discipline therefore
// tracks the stamped users/org PLUS the deterministic key prefix + period keys recorded in this
// helper's RUN LOG output. A same-day rerun regenerates the SAME deterministic keys.
//
// This helper drives the real staging HTTP API for settings writes and the deliveries read route
// (which has NO source filter param — filtering is client-side by source_key prefix, plus direct PG
// via DATABASE_URL for exact assertions). It intentionally does NOT claim the final RD-4/5 staging
// PASS; the RD-4 config-card browser probe, the send-posture decision, and the final stamp live in
// the runbook.

import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

// --- pure helpers (exported for the companion .test.mjs) -----------------------------------

export const STAMP_PATTERN = /^rd45-smoke-[A-Za-z0-9-]+$/

export const DIGEST_SOURCE_TYPE = 'attendance_report_digest'
export const DIGEST_CADENCE = 'daily'
export const DEFAULT_ORG_ID = 'default'
export const SETTINGS_CACHE_TTL_MS = 60_000 // in-process settings cache in the plugin module

export const DELIVERY_CHANNEL_ALLOWLIST = ['dingtalk_work_notification', 'email_smtp']

// Terminal 'failed' reasons that still count as the design lock's "worker sends/FAILS visibly":
// unbound recipient under the real work-notification channel env, or no channel registered at all.
export const RECOGNIZED_TERMINAL_FAILURES = [
  'dingtalk_recipient_not_bound',
  'attendance_delivery_channel_not_configured',
]

// Every table this helper can dirty. system_configs is mutated via PUT /settings and restored —
// never deleted — so it is preflighted but intentionally NOT in this delete/count triple-check list.
export const RESIDUE_TABLES = ['attendance_notification_deliveries', 'user_orgs', 'users']

// Mirrors DEFAULT_SETTINGS.attendanceReportDigestPolicy (all-off). Used only when the pre-smoke
// settings never carried the policy key (GET normalizes, so normally it does).
export const DISABLED_DIGEST_POLICY_DEFAULT = {
  enabled: false,
  timezone: 'Asia/Shanghai',
  channel: 'work_notification',
  cadences: {
    daily: { enabled: false, sendAt: '18:30', recipients: ['self'] },
    weekly: { enabled: false, weekday: 1, sendAt: '09:00', recipients: ['self'] },
    monthly: { enabled: false, dayOfMonth: 1, sendAt: '09:00', recipients: ['self'] },
  },
}

export function stableJson(value) {
  return JSON.stringify(value ?? null)
}

export function parseJson(value) {
  if (value == null || typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
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

export function utcDateKey(date) {
  return date.toISOString().slice(0, 10)
}

export function addDaysUtc(dateKey, days) {
  const next = new Date(`${dateKey}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

// daily cadence resolves to the previous COMPLETED calendar day in the policy timezone; this smoke
// pins the policy timezone to UTC so the helper-side computation matches the producer exactly.
export function computeCompletedDailyPeriod(todayKey) {
  const day = addDaysUtc(todayKey, -1)
  return { from: day, to: day, periodKey: `${DIGEST_CADENCE}:${day}` }
}

export function minutesUntilUtcMidnight(date) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1))
  return Math.floor((next.getTime() - date.getTime()) / 60_000)
}

// source_key template (implementation supersedes the design-lock §4 doc drift that omits the
// ':subject:' segment):
//   attendance_report_digest:{orgId}:{cadence}:{periodKey}:subject:{subjectUserId}:{recipientRole}:{recipientUserId}:channel:{channel}
// periodKey itself starts with the cadence, so the cadence appears twice for a well-formed key.
export function buildDigestSourceKeyPrefix(orgId, cadence, periodKey) {
  return `${DIGEST_SOURCE_TYPE}:${orgId}:${cadence}:${periodKey}:subject:`
}

export function buildDigestSourceKey({ orgId, cadence, periodKey, subjectUserId, recipientRole, recipientUserId, channel }) {
  return `${buildDigestSourceKeyPrefix(orgId, cadence, periodKey)}${subjectUserId}:${recipientRole}:${recipientUserId}:channel:${channel}`
}

export function parseDigestSourceKey(key) {
  if (typeof key !== 'string' || !key.startsWith(`${DIGEST_SOURCE_TYPE}:`)) return null
  const subjectSplit = key.split(':subject:')
  if (subjectSplit.length !== 2) return null
  const head = subjectSplit[0].slice(DIGEST_SOURCE_TYPE.length + 1) // {orgId}:{cadence}:{periodKey}
  const headParts = head.split(':')
  if (headParts.length < 3) return null
  const orgId = headParts[0]
  const cadence = headParts[1]
  const periodKey = headParts.slice(2).join(':')
  if (!orgId || !cadence || !periodKey.startsWith(`${cadence}:`)) return null
  const tailSplit = subjectSplit[1].split(':channel:')
  if (tailSplit.length !== 2) return null
  const channel = tailSplit[1]
  const recipientParts = tailSplit[0].split(':')
  if (recipientParts.length !== 3) return null
  const [subjectUserId, recipientRole, recipientUserId] = recipientParts
  if (!subjectUserId || !recipientRole || !recipientUserId || !channel) return null
  return { orgId, cadence, periodKey, subjectUserId, recipientRole, recipientUserId, channel }
}

// PUT /api/attendance/settings deep-merges per policy key (and per cadence), so restoring by
// PUT-ing an empty snapshot is a NO-OP that leaks this smoke's policy. The restore body must
// explicitly re-assert attendanceReportDigestPolicy, defaulting to the all-off shape when the
// pre-smoke settings never carried it.
export function buildRestoreDigestPolicyBody(originalSettings) {
  const original = originalSettings && typeof originalSettings === 'object' ? originalSettings : {}
  const policy = original.attendanceReportDigestPolicy
  return {
    ...original,
    attendanceReportDigestPolicy: policy && typeof policy === 'object' ? policy : DISABLED_DIGEST_POLICY_DEFAULT,
  }
}

// Classify worker outcomes for the RD-5 send proof. "Visibly proven" = every row reached a terminal,
// explainable state: 'sent', or 'failed' with a recognized last_error (unbound recipient / channel
// not configured). Anything else (stuck pending/retrying, unexplained failure) is NOT proof.
export function classifySendOutcome(rows) {
  const outcome = {
    total: rows.length,
    sent: 0,
    pending: 0,
    sending: 0,
    retrying: 0,
    failedRecognized: 0,
    failedOther: [],
    unknown: [],
  }
  for (const row of rows) {
    const status = String(row.status ?? '')
    if (status === 'sent') outcome.sent += 1
    else if (status === 'pending') outcome.pending += 1
    else if (status === 'sending') outcome.sending += 1
    else if (status === 'retrying') outcome.retrying += 1
    else if (status === 'failed') {
      if (RECOGNIZED_TERMINAL_FAILURES.includes(String(row.last_error ?? ''))) outcome.failedRecognized += 1
      else outcome.failedOther.push({ id: row.id ?? null, lastError: row.last_error ?? null })
    } else outcome.unknown.push({ id: row.id ?? null, status })
  }
  outcome.terminal = outcome.sent + outcome.failedRecognized + outcome.failedOther.length
  outcome.visiblyProven = rows.length > 0
    && outcome.sent + outcome.failedRecognized === rows.length
    && outcome.failedOther.length === 0
    && outcome.unknown.length === 0
  return outcome
}

// Env-only contract (no CLI args), mirroring the AE-4 / OT-bank v1-8 helpers: BASE_URL/DATABASE_URL
// required, DEPLOY_SHA mandatory (the PASS stamp must name the staging build actually smoked), STAMP
// regex-locked so cleanup remains visibly synthetic and LIKE-free.
export function resolveEnvConfig(env = {}) {
  const errors = []
  const baseUrl = String(env.BASE_URL || env.BASE || '').replace(/\/$/, '')
  const databaseUrl = String(env.DATABASE_URL || '')
  const deploySha = String(env.DEPLOY_SHA || env.EXPECTED_DEPLOY_SHA || '')
  if (!baseUrl || !databaseUrl) {
    errors.push('BASE_URL and DATABASE_URL are required.')
  }
  if (!deploySha || deploySha === '<fill-from-staging-build>') {
    errors.push('DEPLOY_SHA is required so the PASS stamp names the staging build that was actually smoked.')
  }
  const suffix = Date.now().toString(36)
  const stamp = String(env.STAMP || `rd45-smoke-${suffix}`)
  if (!STAMP_PATTERN.test(stamp)) {
    errors.push('STAMP must match /^rd45-smoke-[A-Za-z0-9-]+$/ so cleanup remains visibly synthetic and LIKE-free.')
  }
  const triggerMode = String(env.TRIGGER_MODE || 'seam')
  if (triggerMode !== 'seam' && triggerMode !== 'scheduler') {
    errors.push('TRIGGER_MODE must be "seam" (primary: disposable smoke org via the in-process producer seam) or "scheduler" (optional owner-gated default-org variant).')
  }
  const orgId = String(env.ORG_ID || (triggerMode === 'scheduler' ? DEFAULT_ORG_ID : `${stamp}-org`))
  if (triggerMode === 'seam' && !orgId.startsWith('rd45-smoke-')) {
    errors.push('TRIGGER_MODE=seam requires a DISPOSABLE smoke org: ORG_ID must start with "rd45-smoke-" (default: <STAMP>-org). Never point the seam track at a real org.')
  }
  if (triggerMode === 'scheduler') {
    if (orgId !== DEFAULT_ORG_ID) {
      errors.push('TRIGGER_MODE=scheduler exercises the backend scheduler job, which passes no orgId and is hardwired to the default org; ORG_ID must be "default".')
    }
    if (env.ACK_DEFAULT_ORG_FANOUT !== '1') {
      errors.push('TRIGGER_MODE=scheduler writes one pending digest row for EVERY active default-org member (deterministic keys, cleaned afterwards). Set ACK_DEFAULT_ORG_FANOUT=1 only after the runbook variant decision block is accepted.')
    }
    if (env.WORKER_EXPECTED === '1') {
      errors.push('TRIGGER_MODE=scheduler requires the delivery worker env gate unset/false on the backend (rows must stay pending; no real sends). WORKER_EXPECTED=1 is not allowed in this mode.')
    }
  }
  const intervalRaw = Number.parseInt(String(env.SCHEDULER_INTERVAL_MS ?? ''), 10)
  const schedulerIntervalMs = Number.isInteger(intervalRaw) ? Math.max(intervalRaw, 5000) : 15000
  return {
    ok: errors.length === 0,
    errors,
    config: {
      baseUrl,
      databaseUrl,
      deploySha,
      stamp,
      suffix,
      orgId,
      triggerMode,
      schedulerIntervalMs,
      workerExpected: triggerMode === 'scheduler' ? false : env.WORKER_EXPECTED !== '0',
      allowPreexistingDigestRows: env.ALLOW_PREEXISTING_DIGEST_ROWS === '1',
      allowUtcMidnightCrossing: env.ALLOW_UTC_MIDNIGHT_CROSSING === '1',
      pluginIndexPath: String(env.PLUGIN_INDEX_PATH || ''),
    },
  }
}

// --- runtime wiring -------------------------------------------------------------------------

const IS_MAIN = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
const ENTRY = resolveEnvConfig(process.env)
if (IS_MAIN && !ENTRY.ok) {
  for (const message of ENTRY.errors) console.error(`FAIL: ${message}`)
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet DEPLOY_SHA=<deployed-sha> ADMIN_TOKEN=<jwt> node scripts/ops/staging-attendance-report-digest-rd45-smoke.mjs')
  process.exit(2)
}

const {
  baseUrl: BASE_URL,
  databaseUrl: DATABASE_URL,
  deploySha: DEPLOY_SHA,
  stamp: STAMP,
  orgId: ORG_ID,
  triggerMode: TRIGGER_MODE,
  schedulerIntervalMs: SCHEDULER_INTERVAL_MS,
  workerExpected: WORKER_EXPECTED,
} = ENTRY.config

const USER_PREFIX = `${STAMP}-`
const MEMBER_USER = process.env.MEMBER_USER_ID || `${USER_PREFIX}member`
const INACTIVE_USER = process.env.INACTIVE_USER_ID || `${USER_PREFIX}inactive`
const ADMIN_USER = process.env.ADMIN_USER_ID || `${USER_PREFIX}admin`

// The period is pinned once at process start (policy timezone is set to UTC by this smoke, so the
// helper-side computation matches the producer). The seam track passes this todayKey explicitly and
// is therefore midnight-safe; the scheduler variant guards against UTC-midnight crossings instead.
const RUN_NOW = new Date()
const RUN_TODAY_KEY = utcDateKey(RUN_NOW)
const PERIOD = computeCompletedDailyPeriod(RUN_TODAY_KEY)
const SOURCE_KEY_PREFIX = buildDigestSourceKeyPrefix(ORG_ID, DIGEST_CADENCE, PERIOD.periodKey)

let adminToken = process.env.ADMIN_TOKEN || process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let originalSettings = null
let cleanupAllowed = false
let orgDigestBaseline = 0
let defaultOrgDigestBaseline = 0
let pass = 0
const failures = []

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
  if (typeof userId === 'string' && userId.startsWith(USER_PREFIX) && userId.length > USER_PREFIX.length) return
  throw new Error(`refusing to run: ${label} "${userId}" is not stamped with ${USER_PREFIX}. This smoke deletes its synthetic users during cleanup.`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

async function mintToken(userId, { roles = 'admin', perms }) {
  const res = await api('', `/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`)
  const token = res.body?.token || ''
  if (!token) {
    throw new Error(`could not mint dev-token for ${userId} (status ${res.status}); provide explicit ADMIN_TOKEN for staging environments that disable dev-token`)
  }
  return token
}

async function resolveTokens() {
  assertSyntheticUser(ADMIN_USER, 'ADMIN_USER_ID')
  if (!adminToken) {
    adminToken = await mintToken(ADMIN_USER, {
      roles: 'admin',
      perms: 'attendance:read,attendance:write,attendance:admin',
    })
    console.log('  minted admin dev-token')
  } else {
    const subject = jwtSubject(adminToken)
    if (subject != null) console.log(`  using supplied admin token (subject ${subject})`)
  }
}

// --- preflight -------------------------------------------------------------------------------

async function preflightDatabase() {
  const row = (await q(
    `SELECT
       to_regclass('public.attendance_notification_deliveries') IS NOT NULL AS deliveries_ok,
       to_regclass('public.user_orgs') IS NOT NULL AS user_orgs_ok,
       to_regclass('public.users') IS NOT NULL AS users_ok,
       to_regclass('public.system_configs') IS NOT NULL AS settings_ok`,
  ))[0] || {}
  const ready = Object.values(row).every(value => value === true)
  ok(ready, 'DB assertion channel reachable and RD-4/5 tables exist (attendance_notification_deliveries et al)', row)
  if (!ready) throw new Error('staging DB missing the deliveries table (migration zzzz20260611120000) or DATABASE_URL points at the wrong database')
}

async function countOrgDigestRows(orgId) {
  const rows = await q(
    `SELECT count(*)::int AS n FROM attendance_notification_deliveries WHERE org_id = $1 AND source_type = $2`,
    [orgId, DIGEST_SOURCE_TYPE],
  )
  return Number(rows[0]?.n ?? -1)
}

async function preflightDeliveriesBaseline() {
  // Deterministic-key collision guard: a previous rd45 run of the SAME UTC day against the SAME org
  // would have created rows under this exact prefix (the family deviation — keys carry no stamp).
  const prefixCount = Number((await q(
    `SELECT count(*)::int AS n FROM attendance_notification_deliveries
     WHERE org_id = $1 AND source_type = $2 AND left(source_key, $3) = $4`,
    [ORG_ID, DIGEST_SOURCE_TYPE, SOURCE_KEY_PREFIX.length, SOURCE_KEY_PREFIX],
  ))[0]?.n ?? -1)
  ok(prefixCount === 0, `no pre-existing rows under this run's deterministic source_key prefix (${SOURCE_KEY_PREFIX})`, { prefixCount })
  if (prefixCount !== 0) {
    throw new Error('deterministic-key collision: a previous rd45 run today left digest rows under the same prefix; clean them via the runbook residue block before rerunning')
  }

  orgDigestBaseline = await countOrgDigestRows(ORG_ID)
  defaultOrgDigestBaseline = ORG_ID === DEFAULT_ORG_ID ? orgDigestBaseline : await countOrgDigestRows(DEFAULT_ORG_ID)
  const baselinesClean = orgDigestBaseline === 0 && defaultOrgDigestBaseline === 0
  ok(
    baselinesClean || ENTRY.config.allowPreexistingDigestRows,
    `digest-row baselines (run org: ${orgDigestBaseline}, default org: ${defaultOrgDigestBaseline}${baselinesClean ? '' : '; ALLOW_PREEXISTING_DIGEST_ROWS accepted — residue asserts DELTA=0'})`,
    { orgDigestBaseline, defaultOrgDigestBaseline },
  )
  if (!baselinesClean && !ENTRY.config.allowPreexistingDigestRows) {
    throw new Error('pre-existing attendance_report_digest rows found; inspect them (was the digest producer ever enabled on this stack?) or set ALLOW_PREEXISTING_DIGEST_ROWS=1 to assert baseline-delta instead of absolute zero')
  }

  if (WORKER_EXPECTED) {
    // The delivery worker claims due rows GLOBALLY (C5-5 lesson). This smoke does not change what the
    // already-running window worker does to foreign rows, so this is informational, not a gate.
    const due = Number((await q(
      `SELECT count(*)::int AS n FROM attendance_notification_deliveries
       WHERE status IN ('pending', 'retrying') AND next_attempt_at <= now()`,
    ))[0]?.n ?? -1)
    if (due > 0) console.log(`  WARN: ${due} foreign due delivery row(s) are claimable by the window's live worker (global claim; unrelated to this smoke)`)
  }
}

function guardUtcMidnight() {
  if (TRIGGER_MODE !== 'scheduler') return // seam track pins todayKey explicitly — midnight-safe
  const minutes = minutesUntilUtcMidnight(new Date())
  if (minutes < 30 && !ENTRY.config.allowUtcMidnightCrossing) {
    throw new Error(`only ${minutes} minute(s) until UTC midnight; the scheduler variant's waits would cross the day boundary and flip the due periodKey mid-run. Rerun after midnight or set ALLOW_UTC_MIDNIGHT_CROSSING=1.`)
  }
  ok(true, `UTC-midnight guard ok (${minutes} minutes remaining)`, { minutes })
}

// --- settings --------------------------------------------------------------------------------

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
    `SELECT value::jsonb #> '{attendanceReportDigestPolicy}' AS policy
     FROM system_configs
     WHERE key = 'attendance.settings'
     LIMIT 1`,
  ))[0]
  const policy = parseJson(row?.policy) ?? null
  const coherent = policy && typeof policy === 'object' && policy.enabled === true
  ok(Boolean(coherent), 'API settings write (digest policy enabled) is visible through DATABASE_URL', policy)
  if (!coherent) throw new Error('BASE_URL and DATABASE_URL do not appear coherent for attendance settings')
}

async function enableDigestPolicy() {
  // Exact RD-3 integration-test shape: timezone UTC + daily sendAt 00:00 => due on every tick all
  // day (due-ness is anchor-day + localHHmm >= sendAt, NOT minute-equality); recipients self-only.
  await putSettings({
    attendanceReportDigestPolicy: {
      enabled: true,
      timezone: 'UTC',
      channel: 'work_notification',
      cadences: {
        daily: { enabled: true, sendAt: '00:00', recipients: ['self'] },
      },
    },
  }, 'enable report-digest policy (daily, sendAt=00:00, timezone=UTC, recipients=[self])')
  await verifySettingsCoherence()
}

// --- seed / subjects ---------------------------------------------------------------------------

async function seedUsers() {
  // One ACTIVE member (the window plan's single-member rule for the smoke org) plus one user whose
  // MEMBERSHIP is inactive — proving the producer's active-only subject resolution has teeth.
  for (const [userId, orgActive] of [[MEMBER_USER, true], [INACTIVE_USER, false]]) {
    assertSyntheticUser(userId, 'smoke user')
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, role, is_active)
       VALUES ($1, $2, 'no-login', $3, 'user', true)
       ON CONFLICT (id) DO UPDATE SET is_active = true, email = EXCLUDED.email, name = EXCLUDED.name`,
      [userId, `${userId}@example.test`, userId],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = $3`,
      [userId, ORG_ID, orgActive],
    )
  }
  cleanupAllowed = true
  ok(true, `seeded synthetic member (active) + inactive-membership user into org "${ORG_ID}"`, { stamp: STAMP })
}

async function resolveExpectedSubjects() {
  // Same join discipline as the producer's subject loader: active membership AND active user.
  const rows = await q(
    `SELECT uo.user_id
     FROM user_orgs uo
     JOIN users u ON u.id = uo.user_id
     WHERE uo.org_id = $1 AND uo.is_active = true AND u.is_active = true
     ORDER BY uo.user_id`,
    [ORG_ID],
  )
  const subjects = rows.map(row => String(row.user_id))
  ok(subjects.includes(MEMBER_USER), 'stamped active member is a resolved digest subject', { subjects: subjects.length })
  ok(!subjects.includes(INACTIVE_USER), 'inactive membership is excluded from digest subjects', { subjects: subjects.length })
  if (TRIGGER_MODE === 'seam') {
    ok(subjects.length === 1 && subjects[0] === MEMBER_USER, 'disposable smoke org has exactly ONE active member (window-plan single-member rule)', subjects)
  } else {
    ok(subjects.length >= 1, `default org resolves ${subjects.length} active digest subject(s) — one pending row per subject is expected`, { subjects: subjects.length })
  }
  return subjects
}

// --- trigger tracks ----------------------------------------------------------------------------

function resolvePluginIndexPath() {
  if (ENTRY.config.pluginIndexPath) return ENTRY.config.pluginIndexPath
  const here = dirname(fileURLToPath(import.meta.url))
  return resolvePath(here, '../../plugins/plugin-attendance/index.cjs')
}

function loadDigestSeam() {
  const requireCjs = createRequire(import.meta.url)
  const plugin = requireCjs(resolvePluginIndexPath())
  const seam = plugin?.__attendanceReportDigestForTests
  if (!seam?.runAttendanceReportDigestOnce) {
    throw new Error(`plugin module at ${resolvePluginIndexPath()} does not export __attendanceReportDigestForTests.runAttendanceReportDigestOnce; set PLUGIN_INDEX_PATH or run from a prepared metasheet2 checkout at the deployed SHA`)
  }
  return seam
}

// Same db-adapter shape as the RD-3 integration harness: query -> rows[], transaction(fn) with a
// same-shaped client under BEGIN/COMMIT/ROLLBACK.
function createPluginDb() {
  return {
    async query(sql, params) {
      const result = await pool.query(sql, params)
      return result.rows
    },
    async transaction(handler) {
      const client = await pool.connect()
      const trx = {
        async query(sql, params) {
          const result = await client.query(sql, params)
          return result.rows
        },
      }
      try {
        await client.query('BEGIN')
        const value = await handler(trx)
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  }
}

// The producer env gate is process-local: setting it here affects ONLY this helper process, never
// the backend. The backend's own gate must stay unset/false under the seam track (leakage guard).
async function runSeamOnce({ envEnabled = true } = {}) {
  const seam = loadDigestSeam()
  const previous = process.env.ATTENDANCE_REPORT_DIGEST_ENABLED
  if (envEnabled) process.env.ATTENDANCE_REPORT_DIGEST_ENABLED = 'true'
  else delete process.env.ATTENDANCE_REPORT_DIGEST_ENABLED
  try {
    return await seam.runAttendanceReportDigestOnce(createPluginDb(), {
      orgId: ORG_ID,
      now: RUN_NOW,
      todayKey: RUN_TODAY_KEY,
      logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
      emitEvent: () => undefined,
    })
  } finally {
    if (previous === undefined) delete process.env.ATTENDANCE_REPORT_DIGEST_ENABLED
    else process.env.ATTENDANCE_REPORT_DIGEST_ENABLED = previous
  }
}

async function fetchDigestRows() {
  return q(
    `SELECT id, org_id, source_type, source_id, source_key, recipient_user_id, recipient_role,
            channel, status, last_error, payload
     FROM attendance_notification_deliveries
     WHERE org_id = $1 AND source_type = $2 AND left(source_key, $3) = $4
     ORDER BY source_key ASC`,
    [ORG_ID, DIGEST_SOURCE_TYPE, SOURCE_KEY_PREFIX.length, SOURCE_KEY_PREFIX],
  )
}

async function produceViaSeam(subjects) {
  const result = await runSeamOnce({ envEnabled: true })
  const cadenceEntry = Array.isArray(result?.cadences) ? result.cadences.find(entry => entry?.cadence === DIGEST_CADENCE) : null
  ok(result?.ran === true && cadenceEntry != null, 'seam invocation ran with the daily cadence due', result)
  ok(
    Number(cadenceEntry?.rowsCreated) === subjects.length && Number(cadenceEntry?.rowsExisting ?? 0) === 0,
    `seam produced exactly ${subjects.length} new row(s), zero pre-existing`,
    cadenceEntry,
  )
  return fetchDigestRows()
}

async function produceViaScheduler(subjects) {
  const timeoutMs = 2 * SCHEDULER_INTERVAL_MS + SETTINGS_CACHE_TTL_MS + 30_000
  console.log(`  waiting for the backend scheduler tick: interval=${SCHEDULER_INTERVAL_MS}ms (NO immediate first run — the first tick fires one FULL interval after process start), plus up to 60s in-process settings cache; timeout ${timeoutMs}ms`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await fetchDigestRows()
    if (rows.length >= subjects.length) {
      ok(true, `scheduler tick produced ${rows.length} digest row(s) under the deterministic prefix`, { rows: rows.length })
      return rows
    }
    if (Date.now() > deadline) {
      throw new Error(`no digest rows appeared within ${timeoutMs}ms — verify on the backend: ATTENDANCE_SCHEDULER_ENABLED is exactly 'true', ATTENDANCE_REPORT_DIGEST_ENABLED is truthy, ATTENDANCE_SCHEDULER_INTERVAL_MS matches SCHEDULER_INTERVAL_MS=${SCHEDULER_INTERVAL_MS}, the leader lock (if enabled) is held, and the container was recreated after env changes`)
    }
    await sleep(5000)
  }
}

// --- assertions --------------------------------------------------------------------------------

const KNOWN_STATUSES = ['pending', 'sending', 'sent', 'retrying', 'failed']

function assertProducedGrain(rows, subjects) {
  ok(rows.length === subjects.length, `producer wrote exactly one row per active subject (expected ${subjects.length})`, { rows: rows.length })

  const subjectSet = new Set(subjects)
  const seenSubjects = new Set()
  const badRows = []
  for (const row of rows) {
    const parsed = parseDigestSourceKey(String(row.source_key ?? ''))
    const payload = parseJson(row.payload) ?? {}
    const good = parsed != null
      && parsed.orgId === ORG_ID
      && parsed.cadence === DIGEST_CADENCE
      && parsed.periodKey === PERIOD.periodKey
      && parsed.recipientRole === 'self' // source_key segment uses the CONFIG vocab
      && parsed.subjectUserId === parsed.recipientUserId // recipients=[self] => subject is recipient
      && row.recipient_role === 'subject' // the COLUMN uses the row vocab for self-recipients
      && row.recipient_user_id === parsed.recipientUserId
      && subjectSet.has(parsed.subjectUserId)
      && DELIVERY_CHANNEL_ALLOWLIST.includes(String(row.channel ?? ''))
      && String(row.channel) === parsed.channel
      && row.source_id === `${ORG_ID}:${DIGEST_CADENCE}:${PERIOD.periodKey}`
      && KNOWN_STATUSES.includes(String(row.status ?? ''))
      && payload.kind === DIGEST_SOURCE_TYPE
      && payload.cadence === DIGEST_CADENCE
      && payload?.period?.periodKey === PERIOD.periodKey
    if (!good) badRows.push({ sourceKey: row.source_key, status: row.status, channel: row.channel, recipientRole: row.recipient_role })
    if (parsed) seenSubjects.add(parsed.subjectUserId)
  }
  ok(badRows.length === 0, 'every row carries per-subject grain (":subject:" segment), self/subject role vocab, allowlisted channel, deterministic source_id and digest payload', badRows.slice(0, 3))
  ok(
    seenSubjects.size === subjects.length && subjects.every(subject => seenSubjects.has(subject)),
    'per-subject coverage: every resolved subject appears exactly once in the produced keys',
    { seen: seenSubjects.size, expected: subjects.length },
  )

  const channels = new Set(rows.map(row => String(row.channel ?? '')))
  ok(channels.size === 1, 'all rows carry ONE consistent resolved delivery channel', Array.from(channels))
}

async function assertNoOutsideRecipients(subjects) {
  const rows = await q(
    `SELECT count(*)::int AS n FROM attendance_notification_deliveries
     WHERE org_id = $1 AND source_type = $2 AND left(source_key, $3) = $4
       AND NOT (recipient_user_id = ANY($5::text[]))`,
    [ORG_ID, DIGEST_SOURCE_TYPE, SOURCE_KEY_PREFIX.length, SOURCE_KEY_PREFIX, subjects],
  )
  ok(Number(rows[0]?.n) === 0, 'zero digest rows name a recipient outside the resolved subject set', rows[0])
}

// The deliveries GET route has NO source_type/source_key filter param — only status + pagination.
// Filtering is therefore CLIENT-SIDE by deterministic source_key prefix, paging through the org.
async function assertApiVisibility(expectedCount) {
  let page = 1
  let seen = 0
  let matched = 0
  let total = 0
  for (;;) {
    const res = await api(adminToken, `/api/attendance/notification-deliveries?status=all&page=${page}&pageSize=200`)
    if (res.status !== 200) {
      ok(false, `deliveries GET route readable for org "${ORG_ID}" (status ${res.status}) — see runbook OQ-1 on admin-token org scoping`, res.body)
      return
    }
    const data = res.body?.data ?? {}
    const items = Array.isArray(data.items) ? data.items : []
    total = Number(data.total ?? items.length)
    for (const item of items) {
      if (String(item.sourceKey ?? '').startsWith(SOURCE_KEY_PREFIX)) matched += 1
    }
    seen += items.length
    if (items.length === 0 || seen >= total || page >= 200) break
    page += 1
  }
  ok(matched === expectedCount, `deliveries GET route shows the produced rows via client-side source_key-prefix filtering (${matched}/${expectedCount}; route has no source filter param)`, { matched, expectedCount, total })
}

async function assertReplayIdempotency(subjects) {
  if (TRIGGER_MODE === 'seam') {
    const replay = await runSeamOnce({ envEnabled: true })
    const cadenceEntry = Array.isArray(replay?.cadences) ? replay.cadences.find(entry => entry?.cadence === DIGEST_CADENCE) : null
    ok(
      replay?.ran === true && Number(cadenceEntry?.rowsCreated) === 0 && Number(cadenceEntry?.rowsExisting) === subjects.length,
      'second seam invocation created zero new rows (ON CONFLICT (org_id, source_key) DO NOTHING) and reported all rows existing',
      cadenceEntry ?? replay,
    )
  } else {
    const waitMs = 2 * SCHEDULER_INTERVAL_MS + 10_000
    console.log(`  waiting ${waitMs}ms (>= 2 scheduler ticks) to observe replay dedup on the still-due period...`)
    await sleep(waitMs)
  }
  const rows = await fetchDigestRows()
  const dedupOk = rows.length === subjects.length
  ok(dedupOk, `replay idempotency: TOTAL row count for the period is unchanged (${rows.length}/${subjects.length})`, { rows: rows.length })
  return dedupOk
}

async function assertDisabledPaths(subjects) {
  if (TRIGGER_MODE === 'seam') {
    const envOff = await runSeamOnce({ envEnabled: false })
    ok(envOff?.ran === false && envOff?.reason === 'disabled', 'env-gate off (producer gate unset in the seam process) -> {ran:false, reason:"disabled"}', envOff)

    await putSettings({ attendanceReportDigestPolicy: { enabled: false } }, 'disable report-digest policy (policy-off path)')
    const cacheWaitMs = SETTINGS_CACHE_TTL_MS + 1000
    console.log(`  waiting ${cacheWaitMs}ms for the plugin module's in-process settings cache (60s TTL) to expire before the policy-off seam call...`)
    await sleep(cacheWaitMs)
    const policyOff = await runSeamOnce({ envEnabled: true })
    ok(policyOff?.ran === false && policyOff?.reason === 'disabled', 'policy off (enabled=false) -> {ran:false, reason:"disabled"} even with the env gate on', policyOff)
  } else {
    await putSettings({ attendanceReportDigestPolicy: { enabled: false } }, 'disable report-digest policy (policy-off path)')
    const waitMs = SETTINGS_CACHE_TTL_MS + 2 * SCHEDULER_INTERVAL_MS + 10_000
    console.log(`  waiting ${waitMs}ms (60s settings cache + 2 ticks) to prove the disabled policy stops production...`)
    await sleep(waitMs)
  }
  const rows = await fetchDigestRows()
  ok(rows.length === subjects.length, 'disabled paths produced zero new rows (count unchanged)', { rows: rows.length })
}

// RD-5 send proof. Window state keeps the delivery worker ON (bundle §3.4); under the disposable
// smoke org the fan-out is contained to synthetic users, so sends are harmless and double as the
// send-path proof: every row must reach a terminal, explainable state. Under WORKER_EXPECTED=0 or
// the scheduler variant, the proof inverts: rows must REMAIN pending (nothing may send).
async function assertSendPosture(subjects) {
  if (!WORKER_EXPECTED) {
    const waitMs = 2 * SCHEDULER_INTERVAL_MS + 10_000
    console.log(`  waiting ${waitMs}ms to confirm rows stay pending with the delivery worker off...`)
    await sleep(waitMs)
    const rows = await fetchDigestRows()
    const nonPending = rows.filter(row => String(row.status) !== 'pending')
    ok(
      rows.length === subjects.length && nonPending.length === 0,
      'worker-off posture: every produced row is still status=pending (producer-only proof; no sends occurred)',
      nonPending.slice(0, 3),
    )
    return 'worker-off:pending-only'
  }

  const timeoutMs = 3 * SCHEDULER_INTERVAL_MS + 90_000
  console.log(`  polling for the delivery worker to visibly resolve the smoke-org rows (worker runs on the shared scheduler tick; timeout ${timeoutMs}ms)...`)
  const deadline = Date.now() + timeoutMs
  let outcome = classifySendOutcome(await fetchDigestRows())
  while (outcome.terminal < outcome.total && Date.now() <= deadline) {
    await sleep(5000)
    outcome = classifySendOutcome(await fetchDigestRows())
  }
  ok(
    outcome.visiblyProven,
    `RD-5 send proof: worker visibly resolved every row (sent=${outcome.sent}, failedRecognized=${outcome.failedRecognized}, pending=${outcome.pending}, sending=${outcome.sending}, retrying=${outcome.retrying}, failedOther=${outcome.failedOther.length})`,
    outcome,
  )
  if (!outcome.visiblyProven) {
    throw new Error('delivery worker did not visibly resolve the digest rows — verify the worker env gate, channel envs, and the scheduler interval on the backend, then consult the runbook send-posture table')
  }
  return `worker-on:sent=${outcome.sent},failed_recognized=${outcome.failedRecognized}`
}

async function assertNoDefaultOrgLeakage() {
  if (ORG_ID === DEFAULT_ORG_ID) return // scheduler variant runs ON the default org; residue handles it
  const count = await countOrgDigestRows(DEFAULT_ORG_ID)
  ok(
    count === defaultOrgDigestBaseline,
    'no default-org leakage: the backend producer gate stayed off while the GLOBAL digest policy was enabled for this smoke',
    { count, baseline: defaultOrgDigestBaseline },
  )
  if (count !== defaultOrgDigestBaseline) {
    throw new Error('default-org digest rows appeared during the smoke: the backend has ATTENDANCE_REPORT_DIGEST_ENABLED set. Disable it, then clean the leaked rows via the runbook (deterministic prefix on org default) — do NOT let the worker send them')
  }
}

function printRunLog(rows) {
  console.log('  RUN LOG — deterministic digest keys (record in the runbook worksheet; keys carry NO stamp):')
  console.log(`    periodKey=${PERIOD.periodKey}`)
  console.log(`    sourceKeyPrefix=${SOURCE_KEY_PREFIX}`)
  for (const row of rows) console.log(`    source_key=${row.source_key}`)
}

// --- cleanup / residue -----------------------------------------------------------------------

async function restoreSettings({ strict = false } = {}) {
  if (!originalSettings) return
  const res = await api(adminToken, '/api/attendance/settings', { method: 'PUT', body: buildRestoreDigestPolicyBody(originalSettings) })
  if (strict) {
    ok(res.status === 200, `restore original attendance settings (status ${res.status})`, res.body)
    if (res.status !== 200) throw new Error('failed to restore original attendance settings')
    const restored = await getSettings()
    const restoredPolicy = restored.attendanceReportDigestPolicy ?? null
    const expectedPolicy = originalSettings.attendanceReportDigestPolicy ?? DISABLED_DIGEST_POLICY_DEFAULT
    ok(stableJson(restoredPolicy) === stableJson(expectedPolicy), 'restored attendanceReportDigestPolicy matches the pre-smoke value', restoredPolicy)
    if (stableJson(restoredPolicy) !== stableJson(expectedPolicy)) {
      throw new Error('attendanceReportDigestPolicy did not restore to its pre-smoke value')
    }
    return
  }
  if (res.status !== 200) {
    console.error(`WARN: failed to restore attendance settings (status ${res.status})`)
  }
}

async function cleanup({ strictSettingsRestore = false } = {}) {
  if (!cleanupAllowed) return
  // Cleanup-order trap: restore/disable the policy BEFORE deleting rows — while the policy and the
  // producer gate are both live, the still-open period is re-inserted on the next producer run.
  await restoreSettings({ strict: strictSettingsRestore }).catch(error => {
    if (strictSettingsRestore) throw error
    console.error(`WARN: failed to restore attendance settings: ${error?.message || error}`)
  })
  if (TRIGGER_MODE === 'seam') {
    // The smoke org is disposable and stamped, so an org-scoped source_type delete is safe there.
    await pool.query(
      'DELETE FROM attendance_notification_deliveries WHERE org_id = $1 AND source_type = $2',
      [ORG_ID, DIGEST_SOURCE_TYPE],
    ).catch(() => undefined)
  } else {
    // NEVER org-wide on the default org: delete strictly by the deterministic source_key prefix.
    await pool.query(
      'DELETE FROM attendance_notification_deliveries WHERE org_id = $1 AND source_type = $2 AND left(source_key, $3) = $4',
      [ORG_ID, DIGEST_SOURCE_TYPE, SOURCE_KEY_PREFIX.length, SOURCE_KEY_PREFIX],
    ).catch(() => undefined)
  }
  await pool.query('DELETE FROM user_orgs WHERE org_id = $1 AND left(user_id, $2) = $3', [ORG_ID, USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
  await pool.query('DELETE FROM users WHERE left(id, $1) = $2', [USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
}

async function residueCounts() {
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_notification_deliveries
         WHERE org_id = $1 AND source_type = $2 AND left(source_key, $3) = $4) AS prefix_deliveries,
       (SELECT count(*)::int FROM attendance_notification_deliveries
         WHERE org_id = $1 AND source_type = $2) AS org_digest_deliveries,
       (SELECT count(*)::int FROM attendance_notification_deliveries
         WHERE left(recipient_user_id, $5) = $6) AS smoke_recipient_deliveries,
       (SELECT count(*)::int FROM user_orgs WHERE org_id = $1 AND left(user_id, $5) = $6) AS user_orgs,
       (SELECT count(*)::int FROM users WHERE left(id, $5) = $6) AS users`,
    [ORG_ID, DIGEST_SOURCE_TYPE, SOURCE_KEY_PREFIX.length, SOURCE_KEY_PREFIX, USER_PREFIX.length, USER_PREFIX],
  ))[0] || {}
  const residue = {
    prefix_deliveries: Number(row.prefix_deliveries ?? -1),
    org_digest_delta: Number(row.org_digest_deliveries ?? -1) - orgDigestBaseline,
    smoke_recipient_deliveries: Number(row.smoke_recipient_deliveries ?? -1),
    user_orgs: Number(row.user_orgs ?? -1),
    users: Number(row.users ?? -1),
  }
  if (ORG_ID !== DEFAULT_ORG_ID) {
    residue.default_org_digest_delta = (await countOrgDigestRows(DEFAULT_ORG_ID)) - defaultOrgDigestBaseline
  }
  return residue
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  console.log(`RD-4/5 report-digest API/DB staging smoke helper @ ${BASE_URL}`)
  console.log(`  deploy=${DEPLOY_SHA} org=${ORG_ID} stamp=${STAMP} mode=${TRIGGER_MODE} workerExpected=${WORKER_EXPECTED ? 1 : 0}`)
  console.log('  NOTE: this helper does not close RD-4/5 by itself; the RD-4 config-card browser probe and the final stamp live in docs/development/attendance-rd45-report-digest-staging-smoke-runbook-20260702.md.')
  console.log('  NOTE: digest source_keys are deterministic (family deviation) — the RUN LOG below is part of the residue record.')

  await resolveTokens()
  await preflightDatabase()
  guardUtcMidnight()
  await preflightDeliveriesBaseline()
  originalSettings = await getSettings()

  await seedUsers()
  const subjects = await resolveExpectedSubjects()
  await enableDigestPolicy()

  const rows = TRIGGER_MODE === 'seam' ? await produceViaSeam(subjects) : await produceViaScheduler(subjects)
  printRunLog(rows)
  assertProducedGrain(rows, subjects)
  await assertNoOutsideRecipients(subjects)
  await assertApiVisibility(subjects.length)

  const dedupOk = await assertReplayIdempotency(subjects)
  await assertDisabledPaths(subjects)
  const sendPosture = await assertSendPosture(subjects)
  await assertNoDefaultOrgLeakage()

  await cleanup({ strictSettingsRestore: true })
  const residue = await residueCounts()
  const residueOk = Object.values(residue).every(value => Number(value) === 0)
  ok(residueOk, 'cleanup residue is zero (deterministic prefix + org deltas + stamped users)', residue)
  if (!residueOk) throw new Error(`residue not zero: ${JSON.stringify(residue)}`)
  if (failures.length) {
    throw new Error(`RD-4/5 API/DB smoke had ${failures.length} failed assertion(s): ${failures.join('; ')}`)
  }

  console.log(`  sendPosture=${sendPosture} periodKey=${PERIOD.periodKey}`)
  console.log(`RD45_REPORT_DIGEST_API_DB_SMOKE_PASS deploy=${DEPLOY_SHA} stamp=${STAMP} org=${ORG_ID} produced=${subjects.length} dedupOk=${dedupOk ? 1 : 0} residue=0`)
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
