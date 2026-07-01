#!/usr/bin/env node
// AE-4 staging smoke helper — anomaly result edit API/DB chain.
//
// This helper drives the real staging HTTP API for result-edit writes and import
// recomputes, and uses SQL only for synthetic seed, exact assertions, and
// cleanup. It intentionally does NOT claim the AE-3 modal/UI PASS; the manual
// UI probe in docs/development/attendance-ae4-anomaly-result-edit-staging-smoke-runbook-20260701.md
// remains required before closing AE-4.

import { randomUUID } from 'node:crypto'

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const ORG_ID = process.env.ORG_ID || 'default'
const DEPLOY_SHA = process.env.DEPLOY_SHA || process.env.EXPECTED_DEPLOY_SHA || ''

if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  e.g. BASE_URL=https://staging.example DATABASE_URL=postgresql://USER@HOST/metasheet DEPLOY_SHA=<sha> node scripts/ops/staging-attendance-ae4-result-edit-smoke.mjs')
  process.exit(2)
}
if (!DEPLOY_SHA || DEPLOY_SHA === '<fill-from-staging-build>') {
  console.error('FAIL: DEPLOY_SHA is required so the PASS stamp names the staging build that was actually smoked.')
  process.exit(2)
}

const SUFFIX = Date.now().toString(36)
const STAMP = process.env.STAMP || `ae4-smoke-${SUFFIX}`
if (!/^ae4-smoke-[A-Za-z0-9-]+$/.test(STAMP)) {
  console.error('FAIL: STAMP must match /^ae4-smoke-[A-Za-z0-9-]+$/ so cleanup remains visibly synthetic and LIKE-free.')
  process.exit(2)
}
const USER_PREFIX = `${STAMP}-`
const ADMIN_USER = process.env.ADMIN_USER_ID || `${USER_PREFIX}admin`
const NON_ADMIN_USER = process.env.NON_ADMIN_USER_ID || `${USER_PREFIX}reader`
const NOTIFY_USER = process.env.NOTIFY_USER_ID || `${USER_PREFIX}notify`
const SKIP_USER = process.env.SKIP_USER_ID || `${USER_PREFIX}skip`
const CLOSED_USER = process.env.CLOSED_USER_ID || `${USER_PREFIX}closed`

let adminToken = process.env.ADMIN_TOKEN || process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let nonAdminToken = process.env.NON_ADMIN_TOKEN || ''
let originalSettings = null
let cleanupAllowed = false
let hasSettlementTable = false
let pass = 0
const failures = []

const recordIds = {
  notify: randomUUID(),
  skip: randomUUID(),
  closed: randomUUID(),
}
const createdCycleIds = []
const importBatchIds = new Set()
const idempotencyKeys = {
  notify: `ae4-smoke:${STAMP}:notify`,
  skip: `ae4-smoke:${STAMP}:skip`,
  closed: `ae4-smoke:${STAMP}:closed`,
  nonAdmin: `ae4-smoke:${STAMP}:non-admin`,
}

let pg
try {
  pg = await import('pg')
} catch {
  console.error('FAIL: package "pg" is required. Run this helper from a prepared metasheet2 checkout with dependencies installed.')
  process.exit(2)
}

const pool = new pg.default.Pool({ connectionString: DATABASE_URL })
const q = (text, params = []) => pool.query(text, params).then(result => result.rows)

const stableJson = (value) => JSON.stringify(value ?? null)

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

function jwtSubject(jwt) {
  try {
    const seg = String(jwt).split('.')[1]
    if (!seg) return null
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))
    return payload.id ?? payload.sub ?? payload.userId ?? null
  } catch {
    return null
  }
}

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

function todayKey() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10)
}

function isWeekend(ymd) {
  const dow = new Date(`${ymd}T00:00:00.000Z`).getUTCDay()
  return dow === 0 || dow === 6
}

function nextWeekday(ymd) {
  let next = ymd
  while (isWeekend(next)) next = addDays(next, 1)
  return next
}

function assertSyntheticUser(userId, label) {
  if (String(userId).startsWith(USER_PREFIX)) return
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

async function mintToken(userId, { roles = 'admin', perms }) {
  const res = await api('', `/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`)
  const token = res.body?.token || ''
  if (!token) {
    throw new Error(`could not mint dev-token for ${userId} (status ${res.status}); provide explicit ADMIN_TOKEN/NON_ADMIN_TOKEN for staging environments that disable dev-token`)
  }
  return token
}

async function resolveTokens() {
  assertSyntheticUser(ADMIN_USER, 'ADMIN_USER_ID')
  assertSyntheticUser(NON_ADMIN_USER, 'NON_ADMIN_USER_ID')
  if (!adminToken) {
    adminToken = await mintToken(ADMIN_USER, {
      roles: 'admin',
      perms: 'attendance:read,attendance:write,attendance:admin,attendance:approve',
    })
    console.log('  minted admin dev-token')
  } else {
    const subject = jwtSubject(adminToken)
    if (subject != null) console.log(`  using supplied admin token (subject ${subject})`)
  }
  if (!nonAdminToken) {
    nonAdminToken = await mintToken(NON_ADMIN_USER, {
      roles: 'user',
      perms: 'attendance:read',
    })
    console.log('  minted non-admin dev-token')
  } else {
    const subject = jwtSubject(nonAdminToken)
    if (subject != null) console.log(`  using supplied non-admin token (subject ${subject})`)
  }
}

async function preflightDatabase() {
  const row = (await q(
    `SELECT
       to_regclass('public.users') IS NOT NULL AS users_ok,
       to_regclass('public.user_orgs') IS NOT NULL AS user_orgs_ok,
       to_regclass('public.attendance_records') IS NOT NULL AS records_ok,
       to_regclass('public.attendance_record_result_edits') IS NOT NULL AS edits_ok,
       to_regclass('public.attendance_notification_deliveries') IS NOT NULL AS deliveries_ok,
       to_regclass('public.attendance_payroll_cycles') IS NOT NULL AS cycles_ok,
       to_regclass('public.attendance_payroll_cycle_settlements') IS NOT NULL AS settlements_ok,
       to_regclass('public.attendance_requests') IS NOT NULL AS requests_ok,
       to_regclass('public.attendance_events') IS NOT NULL AS events_ok,
       to_regclass('public.attendance_import_batches') IS NOT NULL AS import_batches_ok,
       to_regclass('public.attendance_import_items') IS NOT NULL AS import_items_ok,
       to_regclass('public.attendance_import_jobs') IS NOT NULL AS import_jobs_ok,
       to_regclass('public.system_configs') IS NOT NULL AS settings_ok`,
  ))[0] || {}
  hasSettlementTable = row.settlements_ok === true
  const required = { ...row }
  delete required.settlements_ok
  const ready = Object.values(required).every(value => value === true)
  ok(ready, 'DB assertion channel reachable and AE-4 tables exist', row)
  if (!ready) throw new Error('staging DB missing AE-4 tables or DATABASE_URL points at the wrong database')
}

async function preflightNoExistingResidue() {
  const prefixLen = USER_PREFIX.length
  const keyPrefix = `ae4-smoke:${STAMP}:`
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND meta->>'smokeStamp' = $2) AS records,
       (SELECT count(*)::int FROM attendance_record_result_edits
         WHERE org_id = $1
           AND left(idempotency_key, $3) = $4) AS edits,
       (SELECT count(*)::int FROM attendance_notification_deliveries d
         JOIN attendance_record_result_edits e ON d.source_id = e.id::text AND e.org_id = d.org_id
         WHERE d.org_id = $1
           AND d.source_type = 'attendance_result_edit'
           AND left(e.idempotency_key, $3) = $4) AS deliveries,
       (SELECT count(*)::int FROM attendance_payroll_cycles
         WHERE org_id = $1
           AND metadata->>'smokeStamp' = $2) AS cycles,
       (SELECT count(*)::int FROM attendance_requests
         WHERE org_id = $1
           AND metadata->>'smokeStamp' = $2) AS requests,
       (SELECT count(*)::int FROM attendance_events
         WHERE org_id = $1
           AND meta->>'smokeStamp' = $2) AS events,
       (SELECT count(*)::int FROM attendance_import_batches
         WHERE org_id = $1
           AND meta->>'smokeStamp' = $2) AS import_batches,
       (SELECT count(*)::int FROM attendance_import_jobs
         WHERE org_id = $1
           AND batch_id IN (
             SELECT id FROM attendance_import_batches WHERE org_id = $1 AND meta->>'smokeStamp' = $2
           )) AS import_jobs,
       (SELECT count(*)::int FROM user_orgs WHERE org_id = $1 AND left(user_id, $5) = $6) AS user_orgs,
       (SELECT count(*)::int FROM users WHERE left(id, $5) = $6) AS users`,
    [ORG_ID, STAMP, keyPrefix.length, keyPrefix, prefixLen, USER_PREFIX],
  ))[0] || {}
  const clean = Object.values(row).every(value => Number(value) === 0)
  ok(clean, 'no pre-existing residue for this AE-4 smoke stamp', row)
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
    `SELECT value::jsonb #> '{attendanceResultEditPolicy}' AS policy
     FROM system_configs
     WHERE key = 'attendance.settings'
     LIMIT 1`,
  ))[0]
  const policy = row?.policy ?? null
  const coherent = policy && typeof policy === 'object'
  ok(Boolean(coherent), 'API settings write is visible through DATABASE_URL', policy)
  if (!coherent) throw new Error('BASE_URL and DATABASE_URL do not appear coherent for attendance settings')
}

async function chooseWorkDate() {
  let candidate = nextWeekday(addDays(todayKey(), 14))
  for (let i = 0; i < 40; i += 1) {
    const rows = await q(
      `SELECT 1 FROM attendance_payroll_cycles
       WHERE org_id = $1
         AND status IN ('closed', 'archived')
         AND $2::date BETWEEN start_date AND end_date
       LIMIT 1`,
      [ORG_ID, candidate],
    )
    if (!rows.length) return candidate
    candidate = nextWeekday(addDays(candidate, 1))
  }
  throw new Error('could not find a weekday outside closed/archived payroll cycles for the synthetic smoke records')
}

async function seedUsersAndRecords(workDate) {
  for (const userId of [NOTIFY_USER, SKIP_USER, CLOSED_USER, NON_ADMIN_USER]) {
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

  const rows = [
    [recordIds.notify, NOTIFY_USER, workDate, 'notify'],
    [recordIds.skip, SKIP_USER, workDate, 'skip'],
    [recordIds.closed, CLOSED_USER, addDays(workDate, 1), 'closed'],
  ]
  for (const [id, userId, date, label] of rows) {
    await pool.query(
      `INSERT INTO attendance_records
       (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
        work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Asia/Shanghai', $5, $6, 480, 35, 0, 'late', true, $7::jsonb, NULL, now(), now())`,
      [
        id,
        userId,
        ORG_ID,
        date,
        `${date}T01:35:00.000Z`,
        `${date}T10:00:00.000Z`,
        JSON.stringify({ smokeStamp: STAMP, ae4Case: label }),
      ],
    )
  }
  cleanupAllowed = true
  ok(true, 'seeded synthetic users and late anomaly records', { stamp: STAMP, workDate })
}

async function postEdit(body, token = adminToken) {
  return api(token, '/api/attendance/anomaly-result-edits', { method: 'POST', body: { orgId: ORG_ID, ...body } })
}

async function postImport(userId, workDate, fields, key) {
  const res = await api(adminToken, '/api/attendance/import', {
    method: 'POST',
    body: {
      orgId: ORG_ID,
      userId,
      source: 'manual',
      idempotencyKey: key,
      batchMeta: { smokeStamp: STAMP, ae4: true },
      rows: [{ workDate, fields }],
      mode: 'override',
      returnItems: true,
    },
  })
  const batchId = res.body?.data?.batchId
  if (batchId) importBatchIds.add(String(batchId))
  return res
}

async function recordById(id) {
  return (await q('SELECT * FROM attendance_records WHERE id = $1 AND org_id = $2', [id, ORG_ID]))[0] ?? null
}

async function auditRows(recordId) {
  return q(
    `SELECT * FROM attendance_record_result_edits
     WHERE org_id = $1 AND record_id = $2
     ORDER BY created_at ASC`,
    [ORG_ID, recordId],
  )
}

async function deliveryRows(recordId) {
  return q(
    `SELECT * FROM attendance_notification_deliveries
     WHERE org_id = $1
       AND source_type = 'attendance_result_edit'
       AND source_key LIKE $2
     ORDER BY created_at ASC`,
    [ORG_ID, `attendance_result_edit:${ORG_ID}:${recordId}:%`],
  )
}

function parseJson(value) {
  if (value == null || typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

async function assertCorrectedNotifyPath(workDate) {
  await putSettings({
    attendanceResultEditPolicy: {
      enabled: true,
      editWindowDays: 180,
      requireReason: true,
      notifyAffectedEmployee: true,
    },
  }, 'enable result-edit policy with notifyAffectedEmployee=true')
  await verifySettingsCoherence()

  const body = {
    recordId: recordIds.notify,
    targetStatus: 'normal',
    reason: `AE4 smoke ${STAMP} notify path`,
    idempotencyKey: idempotencyKeys.notify,
  }
  const first = await postEdit(body)
  ok(first.status === 200 && first.body?.data?.alreadyApplied === false, 'notify=true correction succeeds through API', first.body)
  const rec = await recordById(recordIds.notify)
  const meta = parseJson(rec?.meta) ?? {}
  const marker = meta.manual_result_edit
  const audits = await auditRows(recordIds.notify)
  const deliveries = await deliveryRows(recordIds.notify)
  ok(rec?.status === 'normal' && Number(rec?.late_minutes) === 0 && Number(rec?.early_leave_minutes) === 0, 'notify record was corrected to normal with anomaly minutes cleared', rec)
  ok(audits.length === 1 && marker?.auditId === audits[0]?.id && marker?.reviewConflict == null, 'manual_result_edit marker carries the real audit id without stale conflict', marker)
  ok(deliveries.length === 1 && audits[0]?.notification_delivery_id === deliveries[0]?.id, 'notify=true enqueued exactly one delivery and back-linked the audit row', { audit: audits[0], delivery: deliveries[0] })
  ok(deliveries[0]?.recipient_user_id === NOTIFY_USER && deliveries[0]?.recipient_role === 'subject', 'delivery is employee-only subject-scoped', deliveries[0])
  const payload = parseJson(deliveries[0]?.payload) ?? {}
  ok(payload.overrideMetrics === undefined && payload.evidence === undefined, 'delivery payload omits raw overrideMetrics/evidence', payload)

  const replay = await postEdit(body)
  ok(replay.status === 200 && replay.body?.data?.alreadyApplied === true, 'same idempotencyKey replay returns alreadyApplied', replay.body)
  ok((await auditRows(recordIds.notify)).length === 1 && (await deliveryRows(recordIds.notify)).length === 1, 'replay writes no duplicate audit or delivery')

  const sameImport = await postImport(NOTIFY_USER, workDate, {
    firstInAt: `${workDate}T01:35:00.000Z`,
    lastOutAt: `${workDate}T10:00:00.000Z`,
  }, `ae4-smoke:${STAMP}:import-same`)
  ok(sameImport.status === 200, 'same-facts import recompute succeeds', sameImport.body)
  const same = await recordById(recordIds.notify)
  ok(same?.status === 'normal' && (parseJson(same?.meta)?.manual_result_edit?.reviewConflict ?? null) === null, 'same-facts recompute preserves correction without reviewConflict', same)

  const changedImport = await postImport(NOTIFY_USER, workDate, {
    firstInAt: `${workDate}T01:55:00.000Z`,
    lastOutAt: `${workDate}T10:00:00.000Z`,
  }, `ae4-smoke:${STAMP}:import-changed`)
  ok(changedImport.status === 200, 'changed-facts import recompute succeeds', changedImport.body)
  const changed = await recordById(recordIds.notify)
  const conflict = parseJson(changed?.meta)?.manual_result_edit?.reviewConflict
  ok(changed?.status === 'normal' && conflict?.state === 'needs_review', 'changed-facts recompute preserves correction and sets needs_review', conflict)
}

async function assertNotifyDisabledPath() {
  await putSettings({
    attendanceResultEditPolicy: {
      enabled: true,
      editWindowDays: 180,
      requireReason: true,
      notifyAffectedEmployee: false,
    },
  }, 'set notifyAffectedEmployee=false')

  const res = await postEdit({
    recordId: recordIds.skip,
    targetStatus: 'normal',
    reason: `AE4 smoke ${STAMP} notify disabled path`,
    idempotencyKey: idempotencyKeys.skip,
  })
  ok(res.status === 200, 'notify=false correction succeeds through API', res.body)
  const audits = await auditRows(recordIds.skip)
  const deliveries = await deliveryRows(recordIds.skip)
  ok(audits.length === 1 && audits[0]?.notification_delivery_id == null && audits[0]?.notification_skipped_reason === 'policy_disabled', 'notify=false records policy_disabled and no delivery back-link', audits[0])
  ok(deliveries.length === 0, 'notify=false writes no attendance_result_edit delivery row', deliveries)
}

async function assertNonAdmin403() {
  const res = await postEdit({
    recordId: recordIds.closed,
    targetStatus: 'normal',
    reason: `AE4 smoke ${STAMP} non-admin should fail`,
    idempotencyKey: `ae4-smoke:${STAMP}:non-admin`,
  }, nonAdminToken)
  ok(res.status === 403, 'non-admin API POST is fail-closed with 403', res.body)
  ok((await auditRows(recordIds.closed)).length === 0 && (await deliveryRows(recordIds.closed)).length === 0, 'non-admin POST writes no audit or delivery')
}

async function assertClosedCycle409(workDate) {
  await putSettings({
    attendanceResultEditPolicy: {
      enabled: true,
      editWindowDays: 180,
      requireReason: true,
      notifyAffectedEmployee: true,
    },
  }, 'restore notify=true before closed-cycle guard')
  const cycleId = randomUUID()
  await pool.query(
    `INSERT INTO attendance_payroll_cycles
       (id, org_id, template_id, name, start_date, end_date, status, metadata)
     VALUES ($1, $2, NULL, $3, $4, $4, 'closed', $5::jsonb)`,
    [cycleId, ORG_ID, `${STAMP}-closed-cycle`, workDate, JSON.stringify({ smokeStamp: STAMP, ae4: true })],
  )
  createdCycleIds.push(cycleId)
  ok(true, 'SQL-seeded stamped closed payroll cycle for guard-only assertion', { cycleId, workDate })

  const edit = await postEdit({
    recordId: recordIds.closed,
    targetStatus: 'normal',
    reason: `AE4 smoke ${STAMP} closed cycle should fail`,
    idempotencyKey: idempotencyKeys.closed,
  })
  ok(edit.status === 409 && edit.body?.error?.code === 'ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED', 'closed-cycle correction returns 409 ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED', edit.body)
  const rec = await recordById(recordIds.closed)
  ok(rec?.status === 'late' && (await auditRows(recordIds.closed)).length === 0 && (await deliveryRows(recordIds.closed)).length === 0, 'closed-cycle rejection leaves record/audit/delivery unchanged')
}

async function collectImportBatchIds() {
  const rows = await q(
    `SELECT id FROM attendance_import_batches
     WHERE org_id = $1
       AND (meta->>'smokeStamp') = $2`,
    [ORG_ID, STAMP],
  )
  for (const row of rows) importBatchIds.add(String(row.id))
}

async function residueCounts() {
  await collectImportBatchIds().catch(() => undefined)
  const batchIds = Array.from(importBatchIds)
  const cycleIds = createdCycleIds
  const deliveryPatterns = Object.values(recordIds).map(id => `attendance_result_edit:${ORG_ID}:${id}:%`)
  const editKeys = Object.values(idempotencyKeys)
  const rows = await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND meta->>'smokeStamp' = $2) AS records,
       (SELECT count(*)::int FROM attendance_record_result_edits
         WHERE org_id = $1
           AND (record_id = ANY($3::uuid[]) OR idempotency_key = ANY($4::text[]))) AS edits,
       (SELECT count(*)::int FROM attendance_notification_deliveries
         WHERE org_id = $1
           AND source_type = 'attendance_result_edit'
           AND source_key LIKE ANY($5::text[])) AS deliveries,
       (SELECT count(*)::int FROM attendance_payroll_cycles
         WHERE org_id = $1
           AND (id = ANY($6::uuid[]) OR metadata->>'smokeStamp' = $2)) AS cycles,
       (SELECT count(*)::int FROM attendance_requests
         WHERE org_id = $1
           AND metadata->>'smokeStamp' = $2) AS requests,
       (SELECT count(*)::int FROM attendance_events
         WHERE org_id = $1
           AND meta->>'smokeStamp' = $2) AS events,
       (SELECT count(*)::int FROM attendance_import_batches
         WHERE org_id = $1
           AND (id = ANY($9::uuid[]) OR meta->>'smokeStamp' = $2)) AS import_batches,
       (SELECT count(*)::int FROM attendance_import_items
         WHERE org_id = $1
           AND batch_id = ANY($9::uuid[])) AS import_items,
       (SELECT count(*)::int FROM attendance_import_jobs
         WHERE org_id = $1
           AND batch_id = ANY($9::uuid[])) AS import_jobs,
       (SELECT count(*)::int FROM user_orgs WHERE org_id = $1 AND left(user_id, $7) = $8) AS user_orgs,
       (SELECT count(*)::int FROM users WHERE left(id, $7) = $8) AS users`,
    [
      ORG_ID,
      STAMP,
      Object.values(recordIds),
      editKeys,
      deliveryPatterns,
      cycleIds,
      USER_PREFIX.length,
      USER_PREFIX,
      batchIds,
    ],
  )
  const residue = rows[0] ?? {}
  if (hasSettlementTable) {
    const settlementRows = await q(
      `SELECT count(*)::int AS settlements
       FROM attendance_payroll_cycle_settlements
       WHERE org_id = $1
         AND cycle_id = ANY($2::uuid[])`,
      [ORG_ID, cycleIds],
    )
    residue.settlements = Number(settlementRows[0]?.settlements ?? 0)
  }
  return residue
}

async function restoreSettings({ strict = false } = {}) {
  if (!originalSettings) return
  const res = await api(adminToken, '/api/attendance/settings', { method: 'PUT', body: originalSettings })
  if (strict) {
    ok(res.status === 200, `restore original attendance settings (status ${res.status})`, res.body)
    if (res.status !== 200) throw new Error('failed to restore original attendance settings')
    const restored = await getSettings()
    const restoredPolicy = restored.attendanceResultEditPolicy ?? null
    const originalPolicy = originalSettings.attendanceResultEditPolicy ?? null
    ok(stableJson(restoredPolicy) === stableJson(originalPolicy), 'restored attendanceResultEditPolicy matches the pre-smoke value', restoredPolicy)
    if (stableJson(restoredPolicy) !== stableJson(originalPolicy)) {
      throw new Error('attendanceResultEditPolicy did not restore to its pre-smoke value')
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
  await collectImportBatchIds().catch(() => undefined)
  const batchIds = Array.from(importBatchIds)
  const cycleIds = createdCycleIds
  const ids = Object.values(recordIds)
  const deliveryPatterns = ids.map(id => `attendance_result_edit:${ORG_ID}:${id}:%`)
  const editKeys = Object.values(idempotencyKeys)
  await pool.query('DELETE FROM attendance_notification_deliveries WHERE org_id = $1 AND source_type = $2 AND source_key LIKE ANY($3::text[])', [ORG_ID, 'attendance_result_edit', deliveryPatterns]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_record_result_edits WHERE org_id = $1 AND (record_id = ANY($2::uuid[]) OR idempotency_key = ANY($3::text[]))', [ORG_ID, ids, editKeys]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_records WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR meta->>$3 = $4)', [ORG_ID, ids, 'smokeStamp', STAMP]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_events WHERE org_id = $1 AND meta->>$2 = $3', [ORG_ID, 'smokeStamp', STAMP]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_requests WHERE org_id = $1 AND metadata->>$2 = $3', [ORG_ID, 'smokeStamp', STAMP]).catch(() => undefined)
  if (batchIds.length) {
    await pool.query('DELETE FROM attendance_import_jobs WHERE org_id = $1 AND batch_id = ANY($2::uuid[])', [ORG_ID, batchIds]).catch(() => undefined)
    await pool.query('DELETE FROM attendance_import_items WHERE org_id = $1 AND batch_id = ANY($2::uuid[])', [ORG_ID, batchIds]).catch(() => undefined)
    await pool.query('DELETE FROM attendance_import_batches WHERE org_id = $1 AND id = ANY($2::uuid[])', [ORG_ID, batchIds]).catch(() => undefined)
  }
  await pool.query('DELETE FROM attendance_payroll_cycle_settlements WHERE cycle_id = ANY($1::uuid[])', [cycleIds]).catch(() => undefined)
  await pool.query('DELETE FROM attendance_payroll_cycles WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR metadata->>$3 = $4)', [ORG_ID, cycleIds, 'smokeStamp', STAMP]).catch(() => undefined)
  await pool.query('DELETE FROM user_orgs WHERE org_id = $1 AND left(user_id, $2) = $3', [ORG_ID, USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
  await pool.query('DELETE FROM users WHERE left(id, $1) = $2', [USER_PREFIX.length, USER_PREFIX]).catch(() => undefined)
}

async function main() {
  console.log(`AE-4 result-edit API/DB staging smoke helper @ ${BASE_URL}`)
  console.log(`  deploy=${DEPLOY_SHA} org=${ORG_ID} stamp=${STAMP}`)
  console.log('  NOTE: this helper does not prove the AE-3 modal UI; run the manual UI step in the AE-4 runbook before closing AE-4.')

  assertSyntheticUser(NOTIFY_USER, 'NOTIFY_USER_ID')
  assertSyntheticUser(SKIP_USER, 'SKIP_USER_ID')
  assertSyntheticUser(CLOSED_USER, 'CLOSED_USER_ID')
  await resolveTokens()
  await preflightDatabase()
  await preflightNoExistingResidue()
  originalSettings = await getSettings()

  const workDate = await chooseWorkDate()
  await seedUsersAndRecords(workDate)
  await assertCorrectedNotifyPath(workDate)
  await assertNotifyDisabledPath()
  await assertNonAdmin403()
  await assertClosedCycle409(addDays(workDate, 1))

  await cleanup({ strictSettingsRestore: true })
  const residue = await residueCounts()
  const residueOk = Object.values(residue).every(value => Number(value) === 0)
  ok(residueOk, 'cleanup residue is zero', residue)
  if (!residueOk) throw new Error(`residue not zero: ${JSON.stringify(residue)}`)
  if (failures.length) {
    throw new Error(`AE-4 API/DB smoke had ${failures.length} failed assertion(s): ${failures.join('; ')}`)
  }

  console.log(`AE4_RESULT_EDIT_API_DB_SMOKE_PASS deploy=${DEPLOY_SHA} stamp=${STAMP} org=${ORG_ID} notifyRecord=${recordIds.notify} skipRecord=${recordIds.skip} residue=0`)
  console.log(`Assertions passed: ${pass}`)
}

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
