#!/usr/bin/env node
// HMR-5 manual missed-punch reminder staging smoke helper — candidate read / enqueue / replay /
// payload-conflict / stale-candidate / out-of-scope / delivery-worker chain for the 人工催办缺卡提醒
// (manual missed-punch reminder) HMR-1..HMR-4 runtime.
//
// This helper scripts the manual SQL/HTTP steps in
// docs/development/attendance-manual-missed-punch-reminder-hmr5-staging-runbook-20260626.md (its
// steps 1, 2, 4, 5, 6, 7, 8, 9). It drives the real staging HTTP API for every business read/write
// (candidates GET, enqueue POST) and uses SQL only for synthetic seed (a disposable org + 4 users +
// a scheduler-scope row + owed-punch attendance_records/-requests), exact assertions the API has no
// read surface for (delivery row source_id/source_key/payload shape, delivery worker status flow),
// and stamped cleanup. It intentionally does NOT automate runbook step 3 (the admin-console UI
// confirm-snapshot probe), which remains a required manual browser step before the final HMR-5 PASS
// stamp — mirroring how the AE-4 / MP-6 helpers leave their own modal/UI steps manual.
//
// Grounding (all on origin/main in plugins/plugin-attendance/index.cjs):
//   ATTENDANCE_SCHEDULER_SCOPE_ACTION_VALUES incl. 'remind' L118; MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE
//   L122; buildOwedPunchRecordPredicateSql / classifyOwedPunchRecord L24626-24658; candidates route
//   L24740-24829 (buildManualMissedPunchReminderCandidateItem L24675 — selectedByDefault =
//   !hasPendingRequest; filterManualMissedPunchReminderCandidatesByScope L24692 — scope filtering runs
//   BEFORE the route's own pageRows.slice() pagination L24792-24795); enqueue route L24831-25060
//   (source_id = sourceType:idempotencyKey, recipient/channel-agnostic, L24881; the existing-source_id
//   replay/conflict check runs BEFORE any stale/scope re-check, L24917-24932; stale re-check FOR UPDATE
//   against the SAME owed-punch predicate L24934-24950 -> 409 MISSED_PUNCH_REMINDER_CANDIDATE_STALE;
//   scope-target check L24952-24955 -> 403 SCHEDULER_SCOPE_FORBIDDEN; per-recipient sourceKey L24994;
//   INSERT ... ON CONFLICT (org_id, source_key) DO NOTHING L25003-25017); delivery status enum L7994;
//   worker terminal-failure strings in
//   packages/core-backend/src/services/AttendanceNotificationDeliveryWorker.ts L272/L399 (the SAME
//   shared C5 worker the RD-4/5 smoke polls — classifySendOutcome below mirrors its helper verbatim).
//
// KNOWN DOC DRIFT (loud, not silent): the runbook's step-4 "Expected" prose shows
// source_key='manual_missed_punch_reminder:<key>:recipient:<worker-id>', but the shipped route (L24994)
// appends a mandatory ':channel:<channel>' suffix — every source_key is keyed by recipient AND channel,
// not recipient alone. This helper asserts the REAL shape via buildDeliverySourceKey() below instead of
// silently passing a doc-drifted assertion; it does not edit the runbook prose (flagged in the PR body).
// A second, lower-stakes drift: the design-lock doc calls the channel resolver
// `resolveAttendanceDefaultDeliveryChannel()`; the shipped function is actually named
// `resolveAttendanceDefaultDeliveryChannelForProducer()` (L60).
//
// Cases (one disposable org; admin / scoped-with-remind-scope / worker(recipient) / outside(unscoped)):
//   read:    admin sees all 3 owed-punch candidates (in-scope + pending-request-visible-but-unselected +
//            out-of-scope); scoped actor sees only the 2 in-scope rows — proving scope filtering runs
//            before pagination, not after.
//   enqueue: scoped actor enqueues the in-scope candidate -> one pending delivery row, real shape.
//   replay:  same idempotencyKey + identical payload -> no-op (created=0, existing=1).
//   conflict: same idempotencyKey + different message -> 409 MISSED_PUNCH_REMINDER_IDEMPOTENCY_CONFLICT.
//   stale:   candidate SQL-flipped to non-remindable + a FRESH key -> 409 MISSED_PUNCH_REMINDER_CANDIDATE_STALE.
//   scope:   out-of-scope candidate + a FRESH key -> 403 SCHEDULER_SCOPE_FORBIDDEN.
//   worker:  poll the shared C5 delivery worker to a terminal, explainable status (WORKER_EXPECTED gate),
//            then confirm one more tick neither duplicates nor resends.
//   residue: stamped cleanup over every dirtied table, residue=0.

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// --- pure helpers (exported for the companion .test.mjs) -----------------------------------

export const STAMP_PATTERN = /^hmr5-smoke-[A-Za-z0-9-]+$/

export const MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE = 'manual_missed_punch_reminder'

// Mirrors ATTENDANCE_ROUTABLE_DEFAULT_DELIVERY_CHANNELS (index.cjs L121).
export const DELIVERY_CHANNEL_ALLOWLIST = ['dingtalk_work_notification', 'email_smtp']

// Terminal 'failed' reasons that still count as a visible, explainable worker outcome (unbound
// recipient under the real work-notification channel env, or no channel registered at all). Identical
// to the RD-4/5 smoke's RECOGNIZED_TERMINAL_FAILURES — this is the SAME shared C5 delivery worker, not
// an HMR-specific list (AttendanceNotificationDeliveryWorker.ts L272/L399).
export const RECOGNIZED_TERMINAL_FAILURES = ['dingtalk_recipient_not_bound', 'attendance_delivery_channel_not_configured']

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

export function isStampedId(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length
}

export function utcDateKey(date) {
  return date.toISOString().slice(0, 10)
}

export function addDaysUtc(dateKey, days) {
  const next = new Date(`${dateKey}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

// source_id is recipient/channel-agnostic (index.cjs L24881) — it groups the WHOLE idempotency key's
// replay/conflict detection, independent of how many recipients a given enqueue call fans out to.
export function buildDeliverySourceId(idempotencyKey) {
  return `${MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE}:${idempotencyKey}`
}

// source_key is per (idempotencyKey, recipient, channel) — index.cjs L24994. See the KNOWN DOC DRIFT
// note above: the runbook prose omits the ':channel:<channel>' suffix that the shipped route requires.
export function buildDeliverySourceKey({ idempotencyKey, recipientUserId, channel }) {
  return `${buildDeliverySourceId(idempotencyKey)}:recipient:${recipientUserId}:channel:${channel}`
}

// Classify worker outcomes for the delivery-status-flow proof. "Visibly proven" = every row reached a
// terminal, explainable state: 'sent', or 'failed' with a recognized last_error. Mirrors the RD-4/5
// smoke's classifySendOutcome (same shared worker / status enum), adapted for HMR-5's naming.
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

// Env-only contract (no CLI args), mirroring the MP-6 / AE-4 / RD-4/5 helpers: BASE_URL/DATABASE_URL
// required, DEPLOY_SHA mandatory (the PASS stamp must name the staging build actually smoked), STAMP
// regex-locked so cleanup stays visibly synthetic and LIKE-free. ORG_ID must be a disposable
// "hmr5-smoke-"-prefixed org (default: "<STAMP>-org") because the candidates route returns an
// ORG-WIDE owed-punch pool with no per-run filter (index.cjs L24781-24790) — running on a shared org
// would make the total= assertions non-deterministic against real staging data.
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
  const stamp = String(env.STAMP || `hmr5-smoke-${suffix}`)
  if (!STAMP_PATTERN.test(stamp)) {
    errors.push('STAMP must match /^hmr5-smoke-[A-Za-z0-9-]+$/ so cleanup remains visibly synthetic and LIKE-free.')
  }
  const orgId = String(env.ORG_ID || `${stamp}-org`)
  if (!orgId.startsWith('hmr5-smoke-')) {
    errors.push('ORG_ID must start with "hmr5-smoke-" (default: "<STAMP>-org"). The candidates route has no per-run filter, so a disposable org is required for a deterministic total= assertion; never point this at a real org.')
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
      schedulerIntervalMs,
      // Default true: the staging window's shared preflight keeps the delivery worker live for the
      // whole window (bundle §3). Set WORKER_EXPECTED=0 for a standalone run with the worker off.
      workerExpected: env.WORKER_EXPECTED !== '0',
    },
  }
}

// --- runtime wiring -------------------------------------------------------------------------

const IS_MAIN = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
const ENTRY = resolveEnvConfig(process.env)
if (IS_MAIN && !ENTRY.ok) {
  for (const message of ENTRY.errors) console.error(`FAIL: ${message}`)
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet DEPLOY_SHA=<deployed-sha> ADMIN_TOKEN=<jwt> SCOPED_TOKEN=<jwt> node scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs')
  process.exit(2)
}

const {
  baseUrl: BASE_URL,
  databaseUrl: DATABASE_URL,
  deploySha: DEPLOY_SHA,
  stamp: STAMP,
  orgId: ORG_ID,
  schedulerIntervalMs: SCHEDULER_INTERVAL_MS,
  workerExpected: WORKER_EXPECTED,
} = ENTRY.config

const USER_PREFIX = `${STAMP}-`
const USERS = {
  admin: process.env.ADMIN_USER_ID || `${USER_PREFIX}admin`,
  scoped: process.env.SCOPED_USER_ID || `${USER_PREFIX}scoped`,
  worker: process.env.WORKER_USER_ID || `${USER_PREFIX}worker`,
  outside: process.env.OUTSIDE_USER_ID || `${USER_PREFIX}outside`,
}

const WORK_DATE = utcDateKey(new Date())
const WORK_DATE_PLUS_1 = addDaysUtc(WORK_DATE, 1)

const recordIds = {
  inScope: randomUUID(),
  pendingControl: randomUUID(),
  outOfScope: randomUUID(),
}
const requestIds = {
  pendingControl: randomUUID(),
}
const idempotencyKeys = {
  api: `hmr5-smoke:${STAMP}:api`,
  stale: `hmr5-smoke:${STAMP}:stale`,
  scope: `hmr5-smoke:${STAMP}:scope`,
}

let adminToken = process.env.ADMIN_TOKEN || process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let scopedToken = process.env.SCOPED_TOKEN || ''
let cleanupAllowed = false
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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
    throw new Error(`could not mint dev-token for ${userId} (status ${res.status}); provide explicit ADMIN_TOKEN/SCOPED_TOKEN for staging environments that 404 the dev-token route (production node-env)`)
  }
  return token
}

async function resolveTokens() {
  assertSyntheticUser(USERS.admin, 'ADMIN_USER_ID')
  assertSyntheticUser(USERS.scoped, 'SCOPED_USER_ID')
  assertSyntheticUser(USERS.worker, 'WORKER_USER_ID')
  assertSyntheticUser(USERS.outside, 'OUTSIDE_USER_ID')
  if (!adminToken) {
    adminToken = await mintToken(USERS.admin, { roles: 'admin', perms: 'attendance:admin,attendance:read,attendance:write' })
    console.log('  minted admin dev-token')
  } else {
    const subject = jwtSubject(adminToken)
    if (subject != null) console.log(`  using supplied admin token (subject ${subject})`)
  }
  if (scopedToken) {
    // Requests are attributed to the token subject (payload.actorUserId); a mismatched supplied token
    // would misattribute the reminder and this smoke would not clean up the real actor.
    const subject = jwtSubject(scopedToken)
    if (subject !== USERS.scoped) {
      throw new Error(`SCOPED_TOKEN subject "${subject}" does not equal the scoped user id "${USERS.scoped}"`)
    }
    console.log(`  using supplied scoped token (subject ${subject})`)
  } else {
    // Scoped actor needs only attendance:read — remind authority comes from the DB scheduler-scope row,
    // never from an RBAC permission string (design-lock §2.4).
    scopedToken = await mintToken(USERS.scoped, { roles: 'user', perms: 'attendance:read' })
    console.log('  minted scoped dev-token')
  }
}

// --- preflight -------------------------------------------------------------------------------

async function preflightDatabase() {
  const row = (await q(
    `SELECT
       to_regclass('public.users') IS NOT NULL AS users_ok,
       to_regclass('public.user_orgs') IS NOT NULL AS user_orgs_ok,
       to_regclass('public.user_roles') IS NOT NULL AS user_roles_ok,
       to_regclass('public.attendance_records') IS NOT NULL AS records_ok,
       to_regclass('public.attendance_requests') IS NOT NULL AS requests_ok,
       to_regclass('public.attendance_scheduler_scopes') IS NOT NULL AS scopes_ok,
       to_regclass('public.attendance_notification_deliveries') IS NOT NULL AS deliveries_ok`,
  ))[0] || {}
  const ready = Object.values(row).every(value => value === true)
  ok(ready, 'DB assertion channel reachable and HMR-5 tables exist', row)
  if (!ready) throw new Error('staging DB missing tables the HMR-5 smoke needs (attendance_scheduler_scopes / attendance_notification_deliveries), or DATABASE_URL points at the wrong database')
}

async function preflightNoExistingResidue() {
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM users WHERE left(id, $1) = $2) AS users,
       (SELECT count(*)::int FROM attendance_scheduler_scopes WHERE org_id = $3) AS scopes,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $3) AS records,
       (SELECT count(*)::int FROM attendance_requests WHERE org_id = $3) AS requests,
       (SELECT count(*)::int FROM attendance_notification_deliveries WHERE org_id = $3) AS deliveries`,
    [USER_PREFIX.length, USER_PREFIX, ORG_ID],
  ))[0] || {}
  const clean = Object.values(row).every(value => Number(value) === 0)
  ok(clean, 'no pre-existing residue for this HMR-5 smoke stamp/org', row)
  if (!clean) throw new Error(`pre-existing residue found for ${STAMP} / org ${ORG_ID}; use a fresh STAMP or inspect before running`)
}

// --- seed --------------------------------------------------------------------------------------

async function seedUsersAndScope() {
  for (const userId of Object.values(USERS)) {
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
  // Central admin permission: hasAttendanceAdminAccess (index.cjs ~L19905) resolves fullAdmin via
  // isAdmin(userId) OR the attendance:admin permission.
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
    [USERS.admin],
  )
  // Scheduler-scope remind authority for exactly the worker (recipient) user — mirrors the runbook's
  // scope = { userIds: [WORKER_ID] } shape; matched by attendanceSchedulerScopeAllowsActorActionFacts
  // against resolveAttendanceUserSchedulerScopeFacts(..., targetUserId) (index.cjs L20951-21014).
  await pool.query(
    `INSERT INTO attendance_scheduler_scopes
       (org_id, subject_type, subject_ref, actions, scope, is_active, created_at, updated_at)
     VALUES ($1, 'user', $2, $3::text[], $4::jsonb, true, now(), now())`,
    [ORG_ID, USERS.scoped, ['remind'], JSON.stringify({ userIds: [USERS.worker] })],
  )
  cleanupAllowed = true
  ok(true, 'seeded disposable org + 4 synthetic users + remind scheduler-scope row', { stamp: STAMP, org: ORG_ID })
}

async function seedOwedPunchRecord(id, userId, workDate, label) {
  await pool.query(
    `INSERT INTO attendance_records
       (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
        work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
        source_batch_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'UTC', NULL, NULL, 0, 0, 0, 'absent', true, $5::jsonb, NULL, now(), now())`,
    [id, userId, ORG_ID, workDate, JSON.stringify({ smokeStamp: STAMP, hmr5Case: label })],
  )
}

async function seedCandidateRecords() {
  // In-scope candidate: worker, today, absent -> selectedByDefault=true (no pending request that day).
  await seedOwedPunchRecord(recordIds.inScope, USERS.worker, WORK_DATE, 'in-scope')

  // Pending-request control: worker, tomorrow, absent + a pending attendance_requests row for the same
  // user/date -> visible but selectedByDefault=false (design-lock §2.1 pending-request rule).
  await seedOwedPunchRecord(recordIds.pendingControl, USERS.worker, WORK_DATE_PLUS_1, 'pending-control')
  await pool.query(
    `INSERT INTO attendance_requests
       (id, user_id, org_id, work_date, request_type, reason, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'missed_check_in', $5, 'pending', now(), now())`,
    [requestIds.pendingControl, USERS.worker, ORG_ID, WORK_DATE_PLUS_1, `HMR-5 smoke ${STAMP} pending-request control`],
  )

  // Out-of-scope candidate: outside user, today, absent -> visible to admin, excluded for the scoped actor.
  await seedOwedPunchRecord(recordIds.outOfScope, USERS.outside, WORK_DATE, 'out-of-scope')

  ok(true, 'seeded 3 owed-punch attendance_records + 1 pending-request control row', {
    inScope: recordIds.inScope,
    pendingControl: recordIds.pendingControl,
    outOfScope: recordIds.outOfScope,
  })
}

// --- candidates read -----------------------------------------------------------------------------

async function getCandidates(token, { from = WORK_DATE, to = WORK_DATE_PLUS_1, pageSize = 50 } = {}) {
  return api(token, `/api/attendance/manual-missed-punch-reminders/candidates?from=${from}&to=${to}&page=1&pageSize=${pageSize}`)
}

function findCandidateItem(items, recordId) {
  return (Array.isArray(items) ? items : []).find(item => item.recordId === recordId) ?? null
}

async function assertAdminSeesAllCandidates() {
  const res = await getCandidates(adminToken)
  // This GET also doubles as the BASE_URL<->DATABASE_URL coherence probe: HMR-5 has no owner-configurable
  // settings policy key to PUT/GET (the delivery channel resolves from an env var, not attendance
  // settings — see the header's KNOWN DOC DRIFT note), so seeing the SQL-seeded rows through the real
  // API is this smoke's coherence proof.
  ok(res.status === 200 && res.body?.ok === true, `admin candidates GET succeeds (status ${res.status}) — API<->DB coherence proof`, res.body)
  if (res.status !== 200) throw new Error('cannot read manual-missed-punch-reminders candidates as admin; BASE_URL/DATABASE_URL may not be coherent, or the HMR-2 route/tables are missing')
  const items = res.body?.data?.items ?? []
  ok(Number(res.body?.data?.total) === 3, 'admin sees all 3 seeded owed-punch candidates (total=3)', res.body?.data?.total)

  const inScope = findCandidateItem(items, recordIds.inScope)
  ok(
    inScope?.userId === USERS.worker && inScope?.selectedByDefault === true && inScope?.missingSide === 'both',
    'in-scope candidate: selectedByDefault=true, missingSide=both (status=absent)',
    inScope,
  )

  const pendingControl = findCandidateItem(items, recordIds.pendingControl)
  ok(
    pendingControl?.selectedByDefault === false && pendingControl?.pendingRequest?.status === 'pending',
    'pending-request candidate: visible but selectedByDefault=false, pendingRequest.status=pending',
    pendingControl,
  )

  const outOfScope = findCandidateItem(items, recordIds.outOfScope)
  ok(outOfScope?.userId === USERS.outside, 'out-of-scope candidate is visible to the central admin', outOfScope)
}

async function assertScopedSeesOnlyInScopeCandidates() {
  const res = await getCandidates(scopedToken)
  ok(res.status === 200 && res.body?.ok === true, `scoped candidates GET succeeds (status ${res.status})`, res.body)
  if (res.status !== 200) throw new Error('scoped actor could not read candidates; verify the seeded remind scheduler-scope row')
  const items = res.body?.data?.items ?? []
  // total reflects the POST-scope-filter count (the route filters, THEN slices for pagination —
  // index.cjs L24792-24795) — proving pagination is applied after scope filtering, not before.
  ok(Number(res.body?.data?.total) === 2, 'scoped actor sees exactly the 2 in-scope candidates (total=2, pagination applied after scope filtering)', res.body?.data?.total)
  ok(!items.some(item => item.userId === USERS.outside), 'no row for the out-of-scope user is visible to the scoped actor', items.map(item => item.userId))

  const pendingControl = findCandidateItem(items, recordIds.pendingControl)
  ok(pendingControl != null && pendingControl.selectedByDefault === false, 'the pending-request candidate remains visible but default-unselected for the scoped actor too', pendingControl)
}

// --- enqueue -------------------------------------------------------------------------------------

async function enqueue(token, { recordIds: ids, message, idempotencyKey }) {
  // NOTE: the enqueue schema is z.object({recordIds,message,idempotencyKey}).strict() (index.cjs
  // L24835-24839) — orgId must NOT be in the body. The generic api() helper already carries orgId via
  // the query string + x-org-id header, which getOrgId(req) reads (index.cjs L5823-5831); this mirrors
  // the runbook's own curl, which passes ?orgId=... on the URL, never in the JSON body (the runbook's
  // own Failure Hints section calls out "Enqueue accepts body orgId" as a strict-schema regression).
  return api(token, '/api/attendance/manual-missed-punch-reminders/enqueue', {
    method: 'POST',
    body: { recordIds: ids, message, idempotencyKey },
  })
}

async function deliveryRowsForKey(idempotencyKey) {
  const sourceId = buildDeliverySourceId(idempotencyKey)
  return q(
    `SELECT * FROM attendance_notification_deliveries
     WHERE org_id = $1 AND source_type = $2 AND source_id = $3
     ORDER BY recipient_user_id ASC`,
    [ORG_ID, MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE, sourceId],
  )
}

async function assertEnqueueCreatesDelivery() {
  const res = await enqueue(scopedToken, {
    recordIds: [recordIds.inScope],
    message: `HMR-5 API ${STAMP}`,
    idempotencyKey: idempotencyKeys.api,
  })
  ok(res.status === 202 && res.body?.ok === true, `scoped enqueue for the in-scope candidate returns 202 (status ${res.status})`, res.body)
  if (res.status !== 202) throw new Error('enqueue for the in-scope candidate failed; cannot continue the HMR-5 chain')
  ok(Number(res.body?.data?.created) === 1 && Number(res.body?.data?.existing) === 0, 'first enqueue reports created=1, existing=0', res.body?.data)

  const rows = await deliveryRowsForKey(idempotencyKeys.api)
  ok(rows.length === 1, 'exactly one attendance_notification_deliveries row exists for this idempotencyKey', rows.length)
  const row = rows[0]
  const expectedSourceKey = buildDeliverySourceKey({ idempotencyKey: idempotencyKeys.api, recipientUserId: USERS.worker, channel: row?.channel })
  ok(row?.source_key === expectedSourceKey, 'source_key carries the REAL shape (…:recipient:<id>:channel:<channel> — the runbook prose omits the channel segment)', { actual: row?.source_key, expected: expectedSourceKey })
  ok(row?.recipient_user_id === USERS.worker && row?.recipient_role === 'subject', 'delivery recipient is the affected employee only, role=subject', row)
  ok(DELIVERY_CHANNEL_ALLOWLIST.includes(String(row?.channel)), 'delivery channel is one of the C5 routable defaults', row?.channel)

  const payload = parseJson(row?.payload) ?? {}
  ok(
    payload.kind === MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE
      && payload.sourceType === MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE
      && payload.idempotencyKey === idempotencyKeys.api
      && payload.actorUserId === USERS.scoped
      && payload.body === `HMR-5 API ${STAMP}`
      && payload.title === 'Missed punch reminder'
      && Array.isArray(payload.recordIds) && payload.recordIds.includes(recordIds.inScope),
    'delivery payload snapshot carries kind/sourceType/idempotencyKey/actorUserId/body/title/recordIds',
    payload,
  )
  // NOTE: no assertion on row.status here. A live shared C5 delivery worker (staging window §3 env
  // flags keep it on for the whole window) can claim this row before the replay/conflict/stale/scope
  // checks below finish running; those checks assert on row COUNT and payload content, which are
  // producer-only concerns unaffected by the worker's race. Status is asserted only in the dedicated
  // worker-status-flow phase further down, which is designed to accept whatever state it finds.
}

async function assertReplayIsIdempotent() {
  const res = await enqueue(scopedToken, {
    recordIds: [recordIds.inScope],
    message: `HMR-5 API ${STAMP}`,
    idempotencyKey: idempotencyKeys.api,
  })
  ok(res.status === 202, `replay with the identical payload returns 202 (status ${res.status})`, res.body)
  ok(Number(res.body?.data?.created) === 0 && Number(res.body?.data?.existing) === 1, 'replay reports created=0, existing=1 (no-op)', res.body?.data)
  const rows = await deliveryRowsForKey(idempotencyKeys.api)
  ok(rows.length === 1, 'replay does not create a duplicate delivery row (count stays 1)', rows.length)
}

async function assertPayloadConflict409() {
  const res = await enqueue(scopedToken, {
    recordIds: [recordIds.inScope],
    message: `HMR-5 API ${STAMP} MUTATED`,
    idempotencyKey: idempotencyKeys.api,
  })
  ok(res.status === 409 && res.body?.error?.code === 'MISSED_PUNCH_REMINDER_IDEMPOTENCY_CONFLICT', `reused key + a different message returns 409 MISSED_PUNCH_REMINDER_IDEMPOTENCY_CONFLICT (status ${res.status})`, res.body)
  const rows = await deliveryRowsForKey(idempotencyKeys.api)
  ok(rows.length === 1, 'the conflict attempt writes no additional row (count stays 1)', rows.length)
  const payload = parseJson(rows[0]?.payload) ?? {}
  ok(payload.body === `HMR-5 API ${STAMP}`, 'the retained row keeps the ORIGINAL message; the conflicting attempt never mutated it', payload.body)
}

async function assertStaleCandidate409() {
  // Flip the in-scope candidate to a normal, fully-punched record so it no longer matches the
  // owed-punch predicate (buildOwedPunchRecordPredicateSql, index.cjs L24626-24633).
  await pool.query(
    `UPDATE attendance_records SET status = 'normal', first_in_at = now(), last_out_at = now(), updated_at = now()
     WHERE id = $1 AND org_id = $2`,
    [recordIds.inScope, ORG_ID],
  )
  // MUST use a FRESH idempotencyKey: the enqueue route checks existing source_id rows for the key
  // BEFORE it ever re-checks candidate staleness (index.cjs L24917-24932) — reusing idempotencyKeys.api
  // here would silently short-circuit to the cached replay and never reach the stale re-check at all.
  const res = await enqueue(scopedToken, {
    recordIds: [recordIds.inScope],
    message: `HMR-5 API ${STAMP} stale`,
    idempotencyKey: idempotencyKeys.stale,
  })
  ok(res.status === 409 && res.body?.error?.code === 'MISSED_PUNCH_REMINDER_CANDIDATE_STALE', `stale candidate + a fresh key returns 409 MISSED_PUNCH_REMINDER_CANDIDATE_STALE (status ${res.status})`, res.body)
  const rows = await deliveryRowsForKey(idempotencyKeys.stale)
  ok(rows.length === 0, 'the stale-candidate attempt writes no delivery row under its fresh key', rows.length)
}

async function assertOutOfScope403() {
  // Fresh key for the same "existing source_id short-circuits before stale/scope" reason as above.
  const res = await enqueue(scopedToken, {
    recordIds: [recordIds.outOfScope],
    message: `HMR-5 API ${STAMP} out-of-scope`,
    idempotencyKey: idempotencyKeys.scope,
  })
  ok(res.status === 403 && res.body?.error?.code === 'SCHEDULER_SCOPE_FORBIDDEN', `out-of-scope target + a fresh key returns 403 SCHEDULER_SCOPE_FORBIDDEN (status ${res.status})`, res.body)
  const rows = await deliveryRowsForKey(idempotencyKeys.scope)
  ok(rows.length === 0, 'the out-of-scope attempt writes no delivery row under its fresh key', rows.length)
}

// --- delivery worker status flow ------------------------------------------------------------------

async function assertWorkerDeliveryStatusFlow() {
  if (!WORKER_EXPECTED) {
    const waitMs = SCHEDULER_INTERVAL_MS + 10_000
    console.log(`  WORKER_EXPECTED=0: waiting ${waitMs}ms to confirm the row stays pending with no worker claim...`)
    await sleep(waitMs)
    const rows = await deliveryRowsForKey(idempotencyKeys.api)
    ok(rows.length === 1 && rows[0]?.status === 'pending', 'worker-off posture: the HMR-5 delivery row stays pending (producer-only proof; no worker claim expected)', rows[0])
    return 'worker-off:pending-only'
  }

  const timeoutMs = 3 * SCHEDULER_INTERVAL_MS + 90_000
  console.log(`  polling for the shared delivery worker to visibly resolve the HMR-5 delivery row (timeout ${timeoutMs}ms)...`)
  const deadline = Date.now() + timeoutMs
  let rows = await deliveryRowsForKey(idempotencyKeys.api)
  let outcome = classifySendOutcome(rows)
  while (outcome.terminal < outcome.total && Date.now() <= deadline) {
    await sleep(5000)
    rows = await deliveryRowsForKey(idempotencyKeys.api)
    outcome = classifySendOutcome(rows)
  }
  ok(
    outcome.visiblyProven,
    `worker visibly resolved the HMR-5 delivery row (sent=${outcome.sent}, failedRecognized=${outcome.failedRecognized}, pending=${outcome.pending}, sending=${outcome.sending}, retrying=${outcome.retrying}, failedOther=${outcome.failedOther.length})`,
    outcome,
  )
  if (!outcome.visiblyProven) {
    throw new Error('delivery worker did not visibly resolve the HMR-5 row — verify ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED + channel envs on the backend, then see the HMR-5 runbook "Worker delivery" step + Failure Hints')
  }
  const settled = rows[0]

  // Repeat-tick guard: one more worker interval must not create a second row for this source, and must
  // not resend/mutate an already-'sent' row (runbook step 9 expectation #2). This is a thin re-check,
  // not a re-derivation of the C5 worker's own no-resend guarantee (already proven generally by the
  // C5-5 smoke, scripts/ops/staging-attendance-c5-delivery-smoke.ts).
  const settleWaitMs = SCHEDULER_INTERVAL_MS + 5000
  console.log(`  waiting ${settleWaitMs}ms for one more worker tick to confirm no duplicate/resend...`)
  await sleep(settleWaitMs)
  const after = await deliveryRowsForKey(idempotencyKeys.api)
  ok(after.length === 1, 'repeat worker tick does not create a second delivery row for this source', after.length)
  if (settled?.status === 'sent') {
    const stillSent = after[0]?.status === 'sent'
      && String(after[0]?.delivered_at) === String(settled.delivered_at)
      && Number(after[0]?.attempt_count) === Number(settled.attempt_count)
    ok(stillSent, 'repeat worker tick does not resend an already-sent HMR-5 row', { before: settled, after: after[0] })
  }
  return outcome.sent > 0 ? 'worker-on:sent' : 'worker-on:failed_recognized'
}

// --- cleanup / residue -----------------------------------------------------------------------

async function residueCounts() {
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_notification_deliveries WHERE org_id = $1 AND source_type = $2) AS deliveries,
       (SELECT count(*)::int FROM attendance_notification_deliveries WHERE left(recipient_user_id, $3) = $4) AS stray_deliveries_by_recipient,
       (SELECT count(*)::int FROM attendance_requests WHERE org_id = $1) AS requests,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1) AS records,
       (SELECT count(*)::int FROM attendance_scheduler_scopes WHERE org_id = $1) AS scopes,
       (SELECT count(*)::int FROM user_roles WHERE user_id = ANY($5::text[])) AS user_roles,
       (SELECT count(*)::int FROM user_orgs WHERE org_id = $1) AS user_orgs,
       (SELECT count(*)::int FROM users WHERE left(id, $3) = $4) AS users`,
    [ORG_ID, MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE, USER_PREFIX.length, USER_PREFIX, Object.values(USERS)],
  ))[0] || {}
  return row
}

async function cleanup() {
  if (!cleanupAllowed) return
  // No hard FK constraints tie these tables to users today, but this ordering still follows every
  // sibling helper's convention (children before parents): deliveries -> requests -> records ->
  // scheduler scopes -> user_roles -> user_orgs -> users. Org-scoped deletes are safe because ORG_ID is
  // this run's disposable smoke org (never the shared/default org).
  await pool.query('DELETE FROM attendance_notification_deliveries WHERE org_id = $1 AND source_type = $2', [ORG_ID, MANUAL_MISSED_PUNCH_REMINDER_SOURCE_TYPE]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_requests WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_records WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_scheduler_scopes WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [Object.values(USERS)]).catch(() => undefined)
  await pool.query('DELETE FROM user_orgs WHERE org_id = $1', [ORG_ID]).catch(() => undefined)
  await pool.query('DELETE FROM users WHERE left(id, $1) = $2', [USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  console.log(`HMR-5 manual missed-punch reminder API/DB staging smoke helper @ ${BASE_URL}`)
  console.log(`  deploy=${DEPLOY_SHA} org=${ORG_ID} stamp=${STAMP} workerExpected=${WORKER_EXPECTED ? 1 : 0}`)
  console.log('  NOTE: this helper does not close HMR-5 by itself. The admin-console UI confirm-snapshot')
  console.log('  step (runbook step 3) is a required manual browser probe with no automated coverage here,')
  console.log('  and the final HMR5_MANUAL_MISSED_PUNCH_REMINDER_STAGING_SMOKE_PASS stamp is recorded only')
  console.log('  after both this helper and that UI step pass, per the HMR-5 runbook.')

  await resolveTokens()
  await preflightDatabase()
  await preflightNoExistingResidue()

  await seedUsersAndScope()
  await seedCandidateRecords()

  await assertAdminSeesAllCandidates()
  await assertScopedSeesOnlyInScopeCandidates()

  await assertEnqueueCreatesDelivery()
  await assertReplayIsIdempotent()
  await assertPayloadConflict409()
  await assertStaleCandidate409()
  await assertOutOfScope403()

  const sendPosture = await assertWorkerDeliveryStatusFlow()

  await cleanup()
  const residue = await residueCounts()
  const residueOk = Object.values(residue).every(value => Number(value) === 0)
  ok(residueOk, 'cleanup residue is zero', residue)
  if (!residueOk) throw new Error(`residue not zero: ${JSON.stringify(residue)}`)
  if (failures.length) {
    throw new Error(`HMR-5 API/DB smoke had ${failures.length} failed assertion(s): ${failures.join('; ')}`)
  }

  console.log(`HMR5_API_DB_SMOKE_PASS deploy=${DEPLOY_SHA} stamp=${STAMP} org=${ORG_ID} sendPosture=${sendPosture} residue=0`)
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
