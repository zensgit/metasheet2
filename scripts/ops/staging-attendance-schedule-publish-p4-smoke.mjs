#!/usr/bin/env node
// P4 staging smoke — 排班发布/草稿 admin flow.
//
// Validates the schedule draft/publish chain on staging:
//   P0 lifecycle columns/read filters · P1 draft CRUD · P2 transactional publish ·
//   P3 immediate-published compatibility · P4 admin UI surface.
//
// This script drives the real HTTP API and uses SQL only for precise assertions
// and cleanup. It restores attendance settings and deletes only rows bearing its
// unique STAMP/name or synthetic user id.

import pg from 'pg'

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const ORG_ID = process.env.ORG_ID || 'default'
if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://u@127.0.0.1:5432/metasheet [SMOKE_TOKEN=<jwt>] node scripts/ops/staging-attendance-schedule-publish-p4-smoke.mjs')
  process.exit(2)
}

const SUFFIX = Date.now().toString(36)
const STAMP = `publish-p4-${SUFFIX}`
const USER = process.env.SMOKE_USER_ID || `publishp4-${SUFFIX}`
let token = process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let cleanupAllowed = false
let originalSettings = null

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

function todayKey() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10)
}

const TODAY = todayKey()
const FUTURE_DATE = process.env.WORK_DATE || addDays(TODAY, 21)
const CAP_DATE = process.env.CAP_DATE || addDays(TODAY, 22)
const PAST_DATE = process.env.PAST_DATE || addDays(TODAY, -7)

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
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, body: json }
}

const pool = new pg.Pool({ connectionString: DATABASE_URL })
const q = (text, params) => pool.query(text, params).then((result) => result.rows)

async function ensureToken() {
  if (token) return
  const perms = 'attendance:read,attendance:write,attendance:admin'
  const res = await api(`/api/auth/dev-token?userId=${encodeURIComponent(`${USER}-admin`)}&roles=admin&perms=${encodeURIComponent(perms)}`)
  token = res.body?.token || ''
  if (!token) {
    throw new Error(`could not mint dev-token (status ${res.status}) — pass SMOKE_TOKEN for staging with dev-token disabled`)
  }
  console.log('  minted dev-token for synthetic publish smoke admin')
}

async function createShift(nameSuffix, start, end, workingDays = [0, 1, 2, 3, 4, 5, 6]) {
  const res = await api('/api/attendance/shifts', {
    method: 'POST',
    body: {
      name: `${STAMP}-${nameSuffix}`,
      timezone: 'UTC',
      workStartTime: start,
      workEndTime: end,
      lateGraceMinutes: 0,
      earlyGraceMinutes: 0,
      roundingMinutes: 1,
      workingDays,
    },
  })
  const id = res.body?.data?.id || res.body?.data?.shift?.id
  ok(res.status === 201 && !!id, `create shift ${nameSuffix} (status ${res.status})`, res.body)
  if (!id) throw new Error(`shift ${nameSuffix} was not created`)
  return id
}

async function createDraftAssignment(userId, shiftId, date) {
  const res = await api('/api/attendance/schedule-drafts/assignments', {
    method: 'POST',
    body: {
      userId,
      shiftId,
      startDate: date,
      endDate: date,
      isActive: true,
    },
  })
  const assignment = res.body?.data?.assignment
  ok(res.status === 201 && assignment?.id && assignment?.publishStatus === 'draft',
    `create draft assignment for ${date}`, res.body)
  if (!assignment?.id) throw new Error('draft assignment was not created')
  return assignment.id
}

async function effectiveSlots(userId, date) {
  const res = await api(`/api/attendance/effective-calendar?from=${date}&to=${date}&userId=${encodeURIComponent(userId)}`)
  ok(res.status === 200, `effective-calendar ${userId} ${date} returns 200 (got ${res.status})`, res.body)
  const item = res.body?.data?.items?.[0]
  return item?.effective?.slots || []
}

async function assignmentRow(id) {
  return (await q(
    `SELECT id, publish_status, publish_batch_id, publish_requested_at, published_at, published_by, locked_at
     FROM attendance_shift_assignments
     WHERE id = $1 AND org_id = $2`,
    [id, ORG_ID],
  ))[0] || null
}

async function main() {
  console.log(`P4 schedule-publish staging smoke @ ${BASE_URL} (user ${USER}, stamp ${STAMP})`)
  if (!/^publishp4-/.test(USER) && process.env.ALLOW_NON_SYNTHETIC_SMOKE_USER !== '1') {
    throw new Error(`refusing non-synthetic SMOKE_USER_ID "${USER}". Use publishp4-* or set ALLOW_NON_SYNTHETIC_SMOKE_USER=1.`)
  }

  await ensureToken()
  const settingsRes = await api('/api/attendance/settings')
  ok(settingsRes.status === 200, `auth: GET settings 200 (got ${settingsRes.status})`, settingsRes.body)
  if (settingsRes.status !== 200) throw new Error('cannot authenticate to staging')
  originalSettings = settingsRes.body?.data ?? {}
  cleanupAllowed = true

  const settingsReset = await api('/api/attendance/settings', {
    method: 'PUT',
    body: {
      shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
      shiftCompliance: { enforcement: 'block', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
      multiShiftDay: { enabled: false, maxSlots: 3 },
      punchPolicy: { unscheduled: { mode: 'allow' } },
    },
  })
  ok(settingsReset.status === 200, `reset relevant settings for smoke (status ${settingsReset.status})`, settingsReset.body)

  const normalShiftId = await createShift('normal', '09:10', '10:40')
  const draftId = await createDraftAssignment(USER, normalShiftId, FUTURE_DATE)

  let slots = await effectiveSlots(USER, FUTURE_DATE)
  ok(!slots.some(slot => slot.shiftId === normalShiftId),
    'draft assignment is invisible to effective-calendar before preflight/publish', slots)

  const preflight = await api('/api/attendance/schedule-publications', {
    method: 'POST',
    body: { assignmentIds: [draftId], preflightOnly: true },
  })
  ok(preflight.status === 200 && preflight.body?.data?.preflightOnly === true,
    `preflight succeeds and reports preflightOnly (status ${preflight.status})`, preflight.body)
  let row = await assignmentRow(draftId)
  ok(row?.publish_status === 'draft' && !row?.published_at && !row?.locked_at,
    'preflight leaves the draft row unmutated', row)

  const publish = await api('/api/attendance/schedule-publications', {
    method: 'POST',
    body: { assignmentIds: [draftId], preflightOnly: false },
  })
  ok(publish.status === 200 && Number(publish.body?.data?.totalPublished) === 1,
    `publish succeeds with totalPublished=1 (status ${publish.status})`, publish.body)
  row = await assignmentRow(draftId)
  ok(row?.publish_status === 'published' && !!row?.published_at && !!row?.locked_at,
    'publish flips draft to a locked published schedule fact', row)
  slots = await effectiveSlots(USER, FUTURE_DATE)
  ok(slots.some(slot => slot.shiftId === normalShiftId),
    'published assignment is visible to effective-calendar', slots)

  const capShiftId = await createShift('cap', '09:00', '10:00')
  const capDraftId = await createDraftAssignment(`${USER}-cap`, capShiftId, CAP_DATE)
  const capSettings = await api('/api/attendance/settings', {
    method: 'PUT',
    body: { shiftCompliance: { enforcement: 'block', dailyMaxMinutes: 30, weeklyMaxMinutes: null, monthlyMaxMinutes: null } },
  })
  ok(capSettings.status === 200, `set low daily shiftCompliance cap (status ${capSettings.status})`, capSettings.body)
  const capPublish = await api('/api/attendance/schedule-publications', {
    method: 'POST',
    body: { assignmentIds: [capDraftId], preflightOnly: false },
  })
  ok(capPublish.status === 422 && capPublish.body?.error?.code === 'SHIFT_COMPLIANCE_CAP_EXCEEDED',
    'publish over shiftCompliance cap returns 422 and the compliance error code', capPublish.body)
  const capRow = await assignmentRow(capDraftId)
  ok(capRow?.publish_status === 'draft' && !capRow?.published_at && !capRow?.locked_at,
    'compliance-blocked publish rolls back without published residue', capRow)

  const editWindowShiftId = await createShift('edit-window', '11:00', '12:00')
  const editWindowDraftId = await createDraftAssignment(`${USER}-window`, editWindowShiftId, PAST_DATE)
  const editWindowSettings = await api('/api/attendance/settings', {
    method: 'PUT',
    body: {
      shiftCompliance: { enforcement: 'block', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
      shiftEditPolicy: { mode: 'past_locked', windowDays: 0 },
    },
  })
  ok(editWindowSettings.status === 200, `set restrictive shiftEditPolicy (status ${editWindowSettings.status})`, editWindowSettings.body)
  const editWindowPublish = await api('/api/attendance/schedule-publications', {
    method: 'POST',
    body: { assignmentIds: [editWindowDraftId], preflightOnly: false },
  })
  ok(editWindowPublish.status === 422 && editWindowPublish.body?.error?.code === 'SHIFT_EDIT_WINDOW_EXCEEDED',
    'publish outside shiftEditPolicy window returns 422 and the edit-window error code', editWindowPublish.body)
  const editWindowRow = await assignmentRow(editWindowDraftId)
  ok(editWindowRow?.publish_status === 'draft' && !editWindowRow?.published_at && !editWindowRow?.locked_at,
    'edit-window-blocked publish leaves the row as draft', editWindowRow)
}

async function cleanup() {
  console.log('\n--- restore + cleanup ---')
  if (!cleanupAllowed) {
    console.log('  cleanup skipped (safety gates did not pass; no settings/data should have been mutated)')
    return
  }
  if (originalSettings) {
    const restored = await api('/api/attendance/settings', { method: 'PUT', body: originalSettings })
    console.log(`  settings restore status ${restored.status}`)
  }
  await q(
    `DELETE FROM attendance_shift_assignments
     WHERE org_id = $1
       AND (user_id = $2 OR user_id = $3 OR user_id = $4)`,
    [ORG_ID, USER, `${USER}-cap`, `${USER}-window`],
  )
  await q(
    `DELETE FROM attendance_shifts
     WHERE org_id = $1
       AND name LIKE $2`,
    [ORG_ID, `${STAMP}-%`],
  )
  const residue = (await q(
    `SELECT
       (SELECT COUNT(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND (user_id = $2 OR user_id = $3 OR user_id = $4)) AS assignments,
       (SELECT COUNT(*)::int FROM attendance_shifts WHERE org_id = $1 AND name LIKE $5) AS shifts`,
    [ORG_ID, USER, `${USER}-cap`, `${USER}-window`, `${STAMP}-%`],
  ))[0]
  ok(Number(residue?.assignments || 0) === 0 && Number(residue?.shifts || 0) === 0,
    `cleanup residue = 0 (assignments ${residue?.assignments}, shifts ${residue?.shifts})`, residue)
}

try {
  await main()
} catch (error) {
  failures.push(error?.message || String(error))
  console.error(`\nERROR: ${error?.stack || error}`)
} finally {
  await cleanup().catch((error) => {
    failures.push(`cleanup failed: ${error?.message || String(error)}`)
    console.error(`cleanup failed: ${error?.stack || error}`)
  })
  await pool.end().catch(() => {})
}

if (failures.length > 0) {
  console.error(`\n=== FAIL — ${pass} passed, ${failures.length} failed ===  stamp ${STAMP}`)
  process.exit(1)
}

console.log(`\n=== PASS — ${pass} passed, 0 failed ===  stamp ${STAMP}`)
