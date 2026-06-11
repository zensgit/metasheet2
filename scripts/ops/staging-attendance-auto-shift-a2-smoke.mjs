#!/usr/bin/env node
// A2-4 staging smoke — auto-shift auto-write.
//
// Validates the A2 guarded background write path against staging data without waiting for
// the interval scheduler. The script runs exactly one exported A2 tick against the staging
// DB, then runs it a second time to prove idempotence.
//
// Prerequisites:
//   - Run from the repo root (or keep this file in scripts/ops) so the attendance plugin can be loaded.
//   - Staging is deployed with a main build containing #2471 and scheduler/A2 runtime flags intended on:
//       ATTENDANCE_SCHEDULER_ENABLED=true
//       ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true
//       ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED=true
//   - BASE_URL points at staging, DATABASE_URL points at the staging postgres.
//
// Usage:
//   BASE_URL=http://127.0.0.1:8082 \
//   DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
//   ATTENDANCE_SCHEDULER_ENABLED=true \
//   ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true \
//   ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED=true \
//   node scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs
//
// Optional:
//   SMOKE_TOKEN=<admin bearer> ORG_ID=default RUN_DATE=2026-06-12

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const ORG_ID = process.env.ORG_ID || 'default'
if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet node scripts/ops/staging-attendance-auto-shift-a2-smoke.mjs')
  process.exit(2)
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
const attendancePlugin = require(path.join(repoRoot, 'plugins/plugin-attendance/index.cjs'))
const autoShiftTests = attendancePlugin.__attendanceAutoShiftForTests
const runner = autoShiftTests?.runAttendanceAutoShiftAutoWriteOnce
const systemRoleTag = autoShiftTests?.AUTO_SHIFT_AUTO_WRITE_SYSTEM_ROLE_TAG || 'system:attendance-auto-shift'
if (typeof runner !== 'function') {
  console.error('FAIL: attendance auto-shift runner export missing. Is the deployed source at/after A2-2?')
  process.exit(2)
}

const SUFFIX = Date.now().toString(36)
const STAMP = `autoshift-a2-smoke-${SUFFIX}`
const SMOKE_STARTED_AT = new Date().toISOString()
const USERS = {
  high: `${STAMP}-high`,
  medium: `${STAMP}-medium`,
  existing: `${STAMP}-existing`,
  fixed: `${STAMP}-fixed`,
  free: `${STAMP}-free`,
}
const ALL_USERS = Object.values(USERS)

function addDays(date, days) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

const runBaseDate = process.env.RUN_DATE ? new Date(`${process.env.RUN_DATE}T12:00:00.000Z`) : new Date()
if (Number.isNaN(runBaseDate.getTime())) {
  console.error(`FAIL: invalid RUN_DATE ${process.env.RUN_DATE}`)
  process.exit(2)
}
const RUN_NOW = new Date(Date.UTC(runBaseDate.getUTCFullYear(), runBaseDate.getUTCMonth(), runBaseDate.getUTCDate(), 12, 0, 0))
const WORK_DATE = process.env.WORK_DATE || addDays(RUN_NOW, 1).toISOString().slice(0, 10)

const highInAt = `${WORK_DATE}T03:10:00.000Z`
const highOutAt = `${WORK_DATE}T04:40:00.000Z`
const mediumInAt = `${WORK_DATE}T11:50:00.000Z`
const mediumOutAt = `${WORK_DATE}T13:20:00.000Z`
const existingInAt = `${WORK_DATE}T20:10:00.000Z`
const existingOutAt = `${WORK_DATE}T21:40:00.000Z`

let token = process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let originalSettings = null
const createdShiftIds = []
const createdGroupIds = []
const createdRunIds = []
let cleanupAllowed = false

let pass = 0
const failures = []
function ok(cond, label, detail) {
  if (cond) {
    pass += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failures.push(label)
  const extra = detail === undefined ? '' : ` — ${JSON.stringify(detail)}`
  console.error(`  FAIL  ${label}${extra}`)
}

function assertRequiredRuntimeEnv() {
  const required = [
    'ATTENDANCE_SCHEDULER_ENABLED',
    'ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED',
    'ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED',
  ]
  const missing = required.filter((name) => process.env[name] !== 'true')
  if (missing.length) {
    throw new Error(`refusing to run: missing required staging runtime env in this runner process: ${missing.join(', ')}. Run from the deployed backend/container environment or export the same flags before invoking the smoke.`)
  }
  ok(true, 'required scheduler/A2 runtime env flags are true')
}

async function api(pathname, { method = 'GET', body } = {}) {
  const url = new URL(`${BASE_URL}${pathname}`)
  if (!url.searchParams.has('orgId')) url.searchParams.set('orgId', ORG_ID)
  const headers = {
    'Content-Type': 'application/json',
    'x-org-id': ORG_ID,
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* non-json */ }
  return { status: res.status, body: json }
}

const pool = new pg.Pool({ connectionString: DATABASE_URL })
const q = (text, params) => pool.query(text, params).then((result) => result.rows)

function createPluginDb(poolForRunner) {
  return {
    query: async (text, params) => (await poolForRunner.query(text, params)).rows,
    transaction: async (callback) => {
      const client = await poolForRunner.connect()
      try {
        await client.query('BEGIN')
        const trx = {
          query: async (text, params) => (await client.query(text, params)).rows,
        }
        const result = await callback(trx)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  }
}

async function mintToken() {
  const userId = `${STAMP}-admin`
  const res = await api(`/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('attendance:read,attendance:write,attendance:admin')}`)
  token = res.body?.token || ''
  if (!token) throw new Error(`could not mint dev-token (status ${res.status}); set SMOKE_TOKEN for staging auth`)
  console.log('  minted dev-token for the smoke admin')
}

async function createShift(name, start, end) {
  const res = await api('/api/attendance/shifts', {
    method: 'POST',
    body: {
      name,
      timezone: 'UTC',
      workStartTime: start,
      workEndTime: end,
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    },
  })
  ok(res.status === 201 && !!res.body?.data?.id, `create shift ${name} (${res.status})`, res.body)
  const id = res.body?.data?.id
  if (!id) throw new Error(`shift ${name} not created`)
  createdShiftIds.push(id)
  return id
}

async function createGroup(name, attendanceType, userIds) {
  const res = await api('/api/attendance/groups', {
    method: 'POST',
    body: {
      name,
      timezone: 'UTC',
      attendanceType,
      description: STAMP,
    },
  })
  ok((res.status === 200 || res.status === 201) && !!res.body?.data?.id, `create ${attendanceType} group ${name} (${res.status})`, res.body)
  const groupId = res.body?.data?.id
  if (!groupId) throw new Error(`group ${name} not created`)
  createdGroupIds.push(groupId)

  const memberRes = await api(`/api/attendance/groups/${groupId}/members`, {
    method: 'POST',
    body: { userIds },
  })
  ok(memberRes.status === 200, `add ${userIds.length} members to ${name}`, memberRes.body)
  if (memberRes.status !== 200) throw new Error(`could not add group members to ${name}`)
  return groupId
}

async function insertPunch(userId, eventType, occurredAt) {
  await q(
    `INSERT INTO attendance_events (id, org_id, user_id, work_date, occurred_at, event_type, source, timezone, meta, created_at)
     VALUES ($1, $2, $3, $4::date, $5::timestamptz, $6, 'smoke', 'UTC', $7::jsonb, now())`,
    [randomUUID(), ORG_ID, userId, WORK_DATE, occurredAt, eventType, JSON.stringify({ stamp: STAMP })],
  )
}

async function seedSchedulerScope() {
  await q(
    `INSERT INTO attendance_scheduler_scopes
     (id, org_id, subject_type, subject_ref, actions, scope, is_active, created_by, updated_by, created_at, updated_at)
     VALUES ($1, $2, 'role_tag', $3, $4::text[], $5::jsonb, TRUE, $6, $6, now(), now())`,
    [
      randomUUID(),
      ORG_ID,
      systemRoleTag,
      ['dispatch'],
      JSON.stringify({
        userIds: ALL_USERS,
        attendanceGroupIds: [],
        scheduleGroupIds: [],
        departments: [],
        roles: [],
        roleTags: [],
      }),
      STAMP,
    ],
  )
}

async function assertNoPreexistingAutoWriteDispatchScope() {
  const rows = await q(
    `SELECT id, scope
       FROM attendance_scheduler_scopes
      WHERE org_id = $1
        AND subject_type = 'role_tag'
        AND subject_ref = $2
        AND is_active = TRUE
        AND actions @> ARRAY['dispatch']::text[]`,
    [ORG_ID, systemRoleTag],
  )
  if (rows.length > 0 && process.env.ALLOW_EXISTING_A2_SYSTEM_SCOPE !== '1') {
    throw new Error(`refusing to enable A2 auto-write while ${rows.length} pre-existing active ${systemRoleTag} dispatch scope(s) exist. They could let the live scheduler write non-smoke users while this smoke turns org auto-write on. Clean/disable those scopes first, or set ALLOW_EXISTING_A2_SYSTEM_SCOPE=1 if you intentionally want to run with them.`)
  }
  ok(rows.length === 0 || process.env.ALLOW_EXISTING_A2_SYSTEM_SCOPE === '1',
    rows.length === 0
      ? 'no pre-existing A2 system dispatch scopes'
      : `existing A2 system dispatch scopes allowed by override (${rows.length})`)
}

function settingsRestorePayload(settings) {
  return {
    autoShiftMatching: settings?.autoShiftMatching ?? {
      enabled: false,
      mode: 'preview',
      maxToleranceMinutes: 60,
      minConfidenceToApply: 'medium',
      autoWrite: { enabled: false, lookaheadDays: 1, maxAssignmentsPerRun: 20, minConfidence: 'high' },
    },
    shiftEditPolicy: settings?.shiftEditPolicy ?? { mode: 'unrestricted', windowDays: 0 },
    shiftCompliance: settings?.shiftCompliance ?? { enforcement: 'block', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
  }
}

function comparableSettings(settings) {
  return JSON.stringify({
    autoShiftMatching: settings?.autoShiftMatching ?? null,
    shiftEditPolicy: settings?.shiftEditPolicy ?? null,
    shiftCompliance: settings?.shiftCompliance ?? null,
  })
}

async function collectSmokeRunIds() {
  const rows = await q(
    `SELECT DISTINCT r.id
       FROM attendance_auto_shift_auto_write_runs r
       LEFT JOIN attendance_auto_shift_auto_write_run_items i
              ON i.run_id = r.id AND i.org_id = r.org_id
      WHERE r.org_id = $1
        AND r.source = 'scheduler'
        AND (
          i.user_id = ANY($2::text[])
          OR (
            r.created_at >= $3::timestamptz
            AND r.target_from = $4::date
            AND r.target_to = $4::date
          )
        )`,
    [ORG_ID, ALL_USERS, SMOKE_STARTED_AT, WORK_DATE],
  )
  const ids = new Set(createdRunIds)
  for (const row of rows) ids.add(row.id)
  return Array.from(ids).filter(Boolean)
}

async function queryRunItems(runId) {
  const rows = await q(
    `SELECT user_id, work_date::text AS work_date, status, reason, confidence, assignment_id, candidate_shift_id
       FROM attendance_auto_shift_auto_write_run_items
      WHERE run_id = $1
      ORDER BY user_id ASC`,
    [runId],
  )
  return Object.fromEntries(rows.map((row) => [row.user_id, row]))
}

async function assignmentCount(userId) {
  const rows = await q(
    `SELECT count(*)::int AS count
       FROM attendance_shift_assignments
      WHERE org_id = $1
        AND user_id = $2
        AND start_date <= $3::date
        AND end_date >= $3::date
        AND is_active = TRUE`,
    [ORG_ID, userId, WORK_DATE],
  )
  return Number(rows[0]?.count || 0)
}

async function main() {
  console.log(`A2-4 auto-shift auto-write staging smoke @ ${BASE_URL}`)
  console.log(`  org ${ORG_ID}, workDate ${WORK_DATE}, runNow ${RUN_NOW.toISOString()}, stamp ${STAMP}`)

  if (!token) await mintToken()

  const got = await api('/api/attendance/settings')
  ok(got.status === 200, `auth/settings reachable (${got.status})`, got.body)
  if (got.status !== 200) throw new Error('settings API not reachable/authenticated')
  originalSettings = got.body?.data ?? {}
  assertRequiredRuntimeEnv()
  await assertNoPreexistingAutoWriteDispatchScope()
  cleanupAllowed = true

  const highShiftId = await createShift(`${STAMP}-high`, '03:10', '04:40')
  const mediumShiftId = await createShift(`${STAMP}-medium`, '11:10', '12:40')
  const existingShiftId = await createShift(`${STAMP}-existing`, '20:10', '21:40')

  await createGroup(`${STAMP}-scheduled`, 'scheduled_shift', ALL_USERS)
  await createGroup(`${STAMP}-fixed`, 'fixed_shift', [USERS.fixed])
  await createGroup(`${STAMP}-free`, 'free_time', [USERS.free])

  await insertPunch(USERS.high, 'check_in', highInAt)
  await insertPunch(USERS.high, 'check_out', highOutAt)
  await insertPunch(USERS.medium, 'check_in', mediumInAt)
  await insertPunch(USERS.medium, 'check_out', mediumOutAt)
  await insertPunch(USERS.existing, 'check_in', existingInAt)
  await insertPunch(USERS.existing, 'check_out', existingOutAt)

  await q(
    `INSERT INTO attendance_shift_assignments
     (id, org_id, user_id, shift_id, start_date, end_date, slot_index, is_active, publish_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::date, $5::date, 0, TRUE, 'published', now(), now())`,
    [randomUUID(), ORG_ID, USERS.existing, existingShiftId, WORK_DATE],
  )
  await seedSchedulerScope()

  const settingsRes = await api('/api/attendance/settings', {
    method: 'PUT',
    body: {
      shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
      shiftCompliance: { enforcement: 'block', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
      autoShiftMatching: {
        enabled: true,
        mode: 'auto',
        maxToleranceMinutes: 180,
        minConfidenceToApply: 'low',
        autoWrite: {
          enabled: true,
          lookaheadDays: 1,
          maxAssignmentsPerRun: 1,
          minConfidence: 'high',
        },
      },
    },
  })
  ok(settingsRes.status === 200, `enable A2 auto-write settings (${settingsRes.status})`, settingsRes.body)
  if (settingsRes.status !== 200) throw new Error('could not enable A2 settings')

  const pluginDb = createPluginDb(pool)
  const firstRun = await runner(pluginDb, {
    orgId: ORG_ID,
    now: RUN_NOW,
    logger: console,
    emitEvent: () => undefined,
  })
  if (firstRun?.runId) createdRunIds.push(firstRun.runId)
  ok(firstRun?.ran === true, 'first tick ran', firstRun)
  ok(firstRun?.appliedCount === 1, 'first tick applied exactly one high-confidence assignment', firstRun)
  ok(firstRun?.errorCount === 0, 'first tick has no errors', firstRun)

  const firstItems = await queryRunItems(firstRun.runId)
  ok(firstItems[USERS.high]?.status === 'applied' && firstItems[USERS.high]?.confidence === 'high', 'high-confidence scheduled-shift user applied', firstItems[USERS.high])
  ok(firstItems[USERS.medium]?.status === 'skipped' && firstItems[USERS.medium]?.reason === 'candidate_below_confidence', 'medium-confidence candidate skipped by high-only auto-write', firstItems[USERS.medium])
  ok(firstItems[USERS.existing]?.status === 'skipped' && firstItems[USERS.existing]?.reason === 'already_scheduled', 'already-scheduled user skipped', firstItems[USERS.existing])
  ok(firstItems[USERS.fixed]?.status === 'skipped' && firstItems[USERS.fixed]?.reason === 'not_scheduled_shift_group', 'fixed-shift member skipped by applicability guard', firstItems[USERS.fixed])
  ok(firstItems[USERS.free]?.status === 'skipped' && firstItems[USERS.free]?.reason === 'not_scheduled_shift_group', 'free-time member skipped by applicability guard', firstItems[USERS.free])

  ok(await assignmentCount(USERS.high) === 1, 'high user has exactly one assignment after first tick')
  ok(await assignmentCount(USERS.medium) === 0, 'medium user has no assignment')
  ok(await assignmentCount(USERS.existing) === 1, 'existing user still has exactly the original assignment')
  ok(await assignmentCount(USERS.fixed) === 0, 'fixed user has no assignment')
  ok(await assignmentCount(USERS.free) === 0, 'free user has no assignment')

  const runApi = await api('/api/attendance/auto-shift-matching/auto-write-runs?page=1&pageSize=5')
  const runItem = (runApi.body?.data?.items ?? []).find((item) => item.id === firstRun.runId)
  const reasons = Object.fromEntries((runItem?.skipReasons ?? []).map((item) => [item.reason, item.count]))
  ok(runApi.status === 200 && !!runItem, 'recent run API returns the smoke run', { status: runApi.status, itemIds: (runApi.body?.data?.items ?? []).map((item) => item.id) })
  ok(reasons.candidate_below_confidence === 1 && reasons.already_scheduled === 1 && reasons.not_scheduled_shift_group === 2,
    'recent run API aggregates skip reasons', reasons)

  const secondRun = await runner(pluginDb, {
    orgId: ORG_ID,
    now: RUN_NOW,
    logger: console,
    emitEvent: () => undefined,
  })
  if (secondRun?.runId) createdRunIds.push(secondRun.runId)
  ok(secondRun?.ran === true, 'repeat tick ran', secondRun)
  ok(secondRun?.appliedCount === 0, 'repeat tick writes zero duplicate assignments', secondRun)
  const secondItems = await queryRunItems(secondRun.runId)
  ok(secondItems[USERS.high]?.status === 'skipped' && secondItems[USERS.high]?.reason === 'already_scheduled',
    'repeat tick sees the applied high user as already scheduled', secondItems[USERS.high])
  ok(await assignmentCount(USERS.high) === 1, 'high user still has exactly one assignment after repeat tick')
}

async function cleanup() {
  console.log('\n--- restore + cleanup ---')
  if (!cleanupAllowed) {
    console.log('  cleanup skipped: smoke did not pass the initial safety/auth gate')
    return
  }
  if (originalSettings) {
    const restoreBody = settingsRestorePayload(originalSettings)
    const restoreRes = await api('/api/attendance/settings', {
      method: 'PUT',
      body: restoreBody,
    }).catch((error) => ({ status: 0, body: { error: error?.message || String(error) } }))
    ok(restoreRes.status === 200, `settings restore status 200 (got ${restoreRes.status})`, restoreRes.body)
    if (restoreRes.status === 200) {
      const verifyRes = await api('/api/attendance/settings')
      const restored = verifyRes.body?.data ?? {}
      ok(verifyRes.status === 200 && comparableSettings(restored) === comparableSettings(restoreBody),
        'settings restored and verified by GET',
        {
          status: verifyRes.status,
          restored: {
            autoShiftMatching: restored.autoShiftMatching,
            shiftEditPolicy: restored.shiftEditPolicy,
            shiftCompliance: restored.shiftCompliance,
          },
        })
    }
  }

  const shiftIds = createdShiftIds
  const groupIds = createdGroupIds
  const runIds = await collectSmokeRunIds()
  await q('DELETE FROM attendance_auto_shift_auto_write_runs WHERE id = ANY($1::uuid[])', [runIds]).catch((error) => console.error(`  delete runs failed: ${error?.message || error}`))
  await q('DELETE FROM attendance_scheduler_scopes WHERE org_id = $1 AND (created_by = $2 OR updated_by = $2)', [ORG_ID, STAMP]).catch((error) => console.error(`  delete scopes failed: ${error?.message || error}`))
  await q('DELETE FROM attendance_shift_assignments WHERE org_id = $1 AND (user_id = ANY($2::text[]) OR shift_id = ANY($3::uuid[]))', [ORG_ID, ALL_USERS, shiftIds]).catch((error) => console.error(`  delete assignments failed: ${error?.message || error}`))
  await q('DELETE FROM attendance_events WHERE org_id = $1 AND user_id = ANY($2::text[])', [ORG_ID, ALL_USERS]).catch((error) => console.error(`  delete events failed: ${error?.message || error}`))
  await q('DELETE FROM attendance_records WHERE org_id = $1 AND user_id = ANY($2::text[])', [ORG_ID, ALL_USERS]).catch((error) => console.error(`  delete records failed: ${error?.message || error}`))
  await q('DELETE FROM attendance_group_members WHERE org_id = $1 AND (group_id = ANY($2::uuid[]) OR user_id = ANY($3::text[]))', [ORG_ID, groupIds, ALL_USERS]).catch((error) => console.error(`  delete group members failed: ${error?.message || error}`))
  await q('DELETE FROM attendance_groups WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR description = $3 OR name LIKE $4)', [ORG_ID, groupIds, STAMP, `${STAMP}%`]).catch((error) => console.error(`  delete groups failed: ${error?.message || error}`))
  await q('DELETE FROM attendance_shifts WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR name LIKE $3)', [ORG_ID, shiftIds, `${STAMP}%`]).catch((error) => console.error(`  delete shifts failed: ${error?.message || error}`))

  const residue = {
    events: Number((await q('SELECT count(*)::int AS count FROM attendance_events WHERE org_id = $1 AND user_id = ANY($2::text[])', [ORG_ID, ALL_USERS]))[0]?.count || 0),
    records: Number((await q('SELECT count(*)::int AS count FROM attendance_records WHERE org_id = $1 AND user_id = ANY($2::text[])', [ORG_ID, ALL_USERS]))[0]?.count || 0),
    assignments: Number((await q('SELECT count(*)::int AS count FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = ANY($2::text[])', [ORG_ID, ALL_USERS]))[0]?.count || 0),
    groups: Number((await q('SELECT count(*)::int AS count FROM attendance_groups WHERE org_id = $1 AND (description = $2 OR name LIKE $3)', [ORG_ID, STAMP, `${STAMP}%`]))[0]?.count || 0),
    shifts: Number((await q('SELECT count(*)::int AS count FROM attendance_shifts WHERE org_id = $1 AND name LIKE $2', [ORG_ID, `${STAMP}%`]))[0]?.count || 0),
    runs: runIds.length ? Number((await q('SELECT count(*)::int AS count FROM attendance_auto_shift_auto_write_runs WHERE id = ANY($1::uuid[])', [runIds]))[0]?.count || 0) : 0,
    runItems: Number((await q('SELECT count(*)::int AS count FROM attendance_auto_shift_auto_write_run_items WHERE org_id = $1 AND user_id = ANY($2::text[])', [ORG_ID, ALL_USERS]))[0]?.count || 0),
    scopes: Number((await q('SELECT count(*)::int AS count FROM attendance_scheduler_scopes WHERE org_id = $1 AND (created_by = $2 OR updated_by = $2)', [ORG_ID, STAMP]))[0]?.count || 0),
  }
  ok(Object.values(residue).every((value) => value === 0), `cleanup residue = 0 ${JSON.stringify(residue)}`, residue)
}

try {
  await main()
} catch (error) {
  failures.push(error?.message || String(error))
  console.error(`\nFAIL: ${error?.stack || error}`)
} finally {
  await cleanup().catch((error) => {
    failures.push(`cleanup failed: ${error?.message || error}`)
    console.error(`cleanup failed: ${error?.stack || error}`)
  })
  await pool.end().catch(() => undefined)
}

if (failures.length) {
  console.error(`\n=== FAIL — ${pass} passed, ${failures.length} failed ===  stamp ${STAMP}`)
  process.exit(1)
}

console.log(`\n=== PASS — ${pass} passed, 0 failed ===  A2_AUTO_SHIFT_STAGING_SMOKE_PASS deploy=<fill-from-staging-build> stamp=${STAMP} workDate=${WORK_DATE} residue=0`)
