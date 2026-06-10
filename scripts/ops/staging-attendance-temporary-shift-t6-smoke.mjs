#!/usr/bin/env node
// T6 staging smoke — 临时班次 replace-only overlay.
//
// Validates the temporary shift chain on staging:
//   T0 temp metadata schema · T1 replace-only runtime · T5 admin UI payload contract.
//
// This script drives the real HTTP API and uses SQL for exact assertions and cleanup.
// It restores attendance settings and deletes only rows bearing its unique stamp or
// synthetic user ids.

import pg from 'pg'

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const ORG_ID = process.env.ORG_ID || 'default'
if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://u@127.0.0.1:5432/metasheet [SMOKE_TOKEN=<jwt>] node scripts/ops/staging-attendance-temporary-shift-t6-smoke.mjs')
  process.exit(2)
}

const SUFFIX = Date.now().toString(36)
const STAMP = `temp-shift-t6-${SUFFIX}`
const USER = process.env.SMOKE_USER_ID || `tempshift-${SUFFIX}`
const FIXED_USER = `${USER}-fixed`
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
const WORK_DATE = process.env.WORK_DATE || addDays(TODAY, 21)
const FIXED_DATE = process.env.FIXED_DATE || addDays(TODAY, 22)

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
  console.log('  minted dev-token for synthetic temporary-shift smoke admin')
}

async function createShift(nameSuffix, start, end) {
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
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    },
  })
  const id = res.body?.data?.id || res.body?.data?.shift?.id
  ok(res.status === 201 && !!id, `create shift ${nameSuffix} (status ${res.status})`, res.body)
  if (!id) throw new Error(`shift ${nameSuffix} was not created`)
  return id
}

async function createPublishedAssignment(userId, shiftId, date, endDate = date) {
  const res = await api('/api/attendance/assignments', {
    method: 'POST',
    body: { userId, shiftId, startDate: date, endDate, isActive: true },
  })
  const assignment = res.body?.data?.assignment
  ok(res.status === 201 && assignment?.id && assignment?.publishStatus === 'published',
    `create published assignment for ${userId} ${date}`, res.body)
  if (!assignment?.id) throw new Error('published assignment was not created')
  return assignment.id
}

async function createTemporaryDraft(userId, replacementShiftId, replacementAssignmentId, date, reason) {
  const res = await api('/api/attendance/schedule-drafts/assignments', {
    method: 'POST',
    body: {
      userId,
      shiftId: replacementShiftId,
      startDate: date,
      endDate: date,
      isActive: true,
      slotIndex: 0,
      assignmentKind: 'temporary',
      temporaryMode: 'replace',
      temporaryReplacesKind: 'shift',
      temporaryReplacesAssignmentId: replacementAssignmentId,
      temporaryReason: reason,
    },
  })
  const assignment = res.body?.data?.assignment
  ok(res.status === 201 && assignment?.id && assignment?.publishStatus === 'draft' && assignment?.assignmentKind === 'temporary',
    `create temporary draft for ${userId} ${date}`, res.body)
  if (!assignment?.id) throw new Error('temporary draft was not created')
  return assignment.id
}

async function publishAssignment(id, label) {
  const res = await api('/api/attendance/schedule-publications', {
    method: 'POST',
    body: { assignmentIds: [id], preflightOnly: false },
  })
  ok(res.status === 200 && Number(res.body?.data?.totalPublished) === 1,
    `publish ${label} (status ${res.status})`, res.body)
}

async function deleteAssignment(id, label) {
  const res = await api(`/api/attendance/assignments/${encodeURIComponent(id)}`, { method: 'DELETE' })
  ok(res.status === 200, `delete/cancel ${label} (status ${res.status})`, res.body)
}

async function effectiveItem(userId, date) {
  const res = await api(`/api/attendance/effective-calendar?from=${date}&to=${date}&userId=${encodeURIComponent(userId)}`)
  ok(res.status === 200, `effective-calendar ${userId} ${date} returns 200 (got ${res.status})`, res.body)
  return res.body?.data?.items?.[0] || null
}

function effectiveShiftId(item) {
  return item?.effective?.shiftId || item?.effective?.shift_id || slotShiftId(effectiveSlots(item)[0]) || null
}

function effectiveSlots(item) {
  return Array.isArray(item?.effective?.slots) ? item.effective.slots : []
}

function hasTemporarySlot(item) {
  return effectiveSlots(item).some(slot => slot?.assignmentKind === 'temporary' || slot?.assignment_kind === 'temporary')
}

function slotShiftId(slot) {
  return slot?.shiftId || slot?.shift_id || null
}

function slotReplacementAssignmentId(slot) {
  return slot?.replaces?.assignmentId || slot?.replaces?.assignment_id || null
}

async function assignmentRow(id) {
  return (await q(
    `SELECT id, shift_id, publish_status, assignment_kind, temporary_mode, temporary_replaces_kind,
            temporary_replaces_assignment_id, temporary_reason, is_active
       FROM attendance_shift_assignments
      WHERE id = $1 AND org_id = $2`,
    [id, ORG_ID],
  ))[0] || null
}

async function createFixedGroup(userId) {
  const groupRes = await api('/api/attendance/groups', {
    method: 'POST',
    body: {
      name: `${STAMP}-fixed-group`,
      timezone: 'UTC',
      attendanceType: 'fixed_shift',
      description: 'temporary-shift staging smoke fixed compatibility',
    },
  })
  const groupId = groupRes.body?.data?.id
  ok(groupRes.status === 200 && !!groupId, `create fixed group (status ${groupRes.status})`, groupRes.body)
  if (!groupId) throw new Error('fixed group was not created')

  const memberRes = await api(`/api/attendance/groups/${groupId}/members`, {
    method: 'POST',
    body: { userIds: [userId] },
  })
  ok(memberRes.status === 200, `add fixed group member (status ${memberRes.status})`, memberRes.body)
  return groupId
}

async function fixedApply(groupId, shiftId, date, verb = 'apply') {
  const res = await api(`/api/attendance/groups/${groupId}/fixed-schedule/${verb}`, {
    method: 'POST',
    body: { shiftId, startDate: date, endDate: date },
  })
  const okStatus = verb === 'apply' ? 201 : 200
  ok(res.status === okStatus, `fixed-schedule ${verb} ${date} (status ${res.status})`, res.body)
  return res
}

async function findAssignmentByUserShiftDate(userId, shiftId, date) {
  return (await q(
    `SELECT id
       FROM attendance_shift_assignments
      WHERE org_id = $1
        AND user_id = $2
        AND shift_id = $3
        AND start_date <= $4::date
        AND COALESCE(end_date, start_date) >= $4::date
        AND COALESCE(is_active, true) = true
      ORDER BY created_at DESC
      LIMIT 1`,
    [ORG_ID, userId, shiftId, date],
  ))[0]?.id || null
}

async function assertTemporaryEffective(userId, date, replacementShiftId, replacementAssignmentId, label) {
  const item = await effectiveItem(userId, date)
  const slots = effectiveSlots(item)
  const tempSlot = slots.find(slot =>
    slot?.assignmentKind === 'temporary'
    || slot?.assignment_kind === 'temporary',
  )
  ok(effectiveShiftId(item) === replacementShiftId,
    `${label}: effective shift is the replacement shift`, item?.effective)
  ok(!!tempSlot && slotShiftId(tempSlot) === replacementShiftId,
    `${label}: effective slots expose the temporary replacement`, slots)
  ok(slotReplacementAssignmentId(tempSlot) === replacementAssignmentId,
    `${label}: temporary slot references the replaced assignment`, tempSlot)
  ok(Number(item?.effective?.plannedMinutes ?? item?.effective?.planned_minutes ?? 0) === 540,
    `${label}: planned minutes use the replacement shift`, item?.effective)
}

async function main() {
  console.log(`T6 temporary-shift staging smoke @ ${BASE_URL} (user ${USER}, stamp ${STAMP})`)
  if (!/^tempshift-/.test(USER) && process.env.ALLOW_NON_SYNTHETIC_SMOKE_USER !== '1') {
    throw new Error(`refusing non-synthetic SMOKE_USER_ID "${USER}". Use tempshift-* or set ALLOW_NON_SYNTHETIC_SMOKE_USER=1.`)
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

  const baseShiftId = await createShift('base', '08:00', '16:00')
  const replacementShiftId = await createShift('replacement', '10:00', '19:00')

  const baseAssignmentId = await createPublishedAssignment(USER, baseShiftId, WORK_DATE, addDays(WORK_DATE, 2))
  let item = await effectiveItem(USER, WORK_DATE)
  ok(item?.effective?.source === 'shift' && !hasTemporarySlot(item),
    'before temp publish, effective-calendar returns the base shift schedule', item?.effective)
  ok(!hasTemporarySlot(item),
    'before temp publish, no temporary slot is visible', effectiveSlots(item))

  const tempDraftId = await createTemporaryDraft(USER, replacementShiftId, baseAssignmentId, WORK_DATE, `${STAMP} one-day replacement`)
  item = await effectiveItem(USER, WORK_DATE)
  ok(item?.effective?.source === 'shift' && !hasTemporarySlot(item),
    'draft temporary assignment is invisible before publication', item?.effective)

  await publishAssignment(tempDraftId, 'temporary replacement draft')
  const baseRow = await assignmentRow(baseAssignmentId)
  const tempRow = await assignmentRow(tempDraftId)
  ok(baseRow?.assignment_kind === 'regular' && baseRow?.publish_status === 'published',
    'base assignment remains a published regular row', baseRow)
  ok(tempRow?.assignment_kind === 'temporary'
      && tempRow?.publish_status === 'published'
      && tempRow?.temporary_mode === 'replace'
      && tempRow?.temporary_replaces_kind === 'shift'
      && tempRow?.temporary_replaces_assignment_id === baseAssignmentId,
    'temporary row is published with replace metadata', tempRow)
  await assertTemporaryEffective(USER, WORK_DATE, replacementShiftId, baseAssignmentId, 'published temp replacement')

  await deleteAssignment(tempDraftId, 'temporary replacement')
  item = await effectiveItem(USER, WORK_DATE)
  ok(item?.effective?.source === 'shift' && !hasTemporarySlot(item),
    'canceling the temporary row restores the base assignment', item?.effective)

  const fixedGroupId = await createFixedGroup(FIXED_USER)
  await fixedApply(fixedGroupId, baseShiftId, FIXED_DATE, 'apply')
  const fixedBaseAssignmentId = await findAssignmentByUserShiftDate(FIXED_USER, baseShiftId, FIXED_DATE)
  ok(!!fixedBaseAssignmentId, 'fixed-schedule apply created a managed base assignment')
  if (!fixedBaseAssignmentId) throw new Error('fixed base assignment missing')
  const fixedTempDraftId = await createTemporaryDraft(FIXED_USER, replacementShiftId, fixedBaseAssignmentId, FIXED_DATE, `${STAMP} fixed replacement`)
  await publishAssignment(fixedTempDraftId, 'fixed temporary replacement draft')
  await assertTemporaryEffective(FIXED_USER, FIXED_DATE, replacementShiftId, fixedBaseAssignmentId, 'fixed temp before rebuild')
  await fixedApply(fixedGroupId, baseShiftId, FIXED_DATE, 'rebuild')
  await assertTemporaryEffective(FIXED_USER, FIXED_DATE, replacementShiftId, fixedBaseAssignmentId, 'fixed temp after rebuild')
}

async function cleanup() {
  console.log('\n--- restore + cleanup ---')
  if (!cleanupAllowed) {
    console.log('  cleanup skipped (safety gates did not pass; no settings/data should have been mutated)')
    return
  }
  if (originalSettings) {
    const restored = await api('/api/attendance/settings', { method: 'PUT', body: originalSettings })
    ok(restored.status === 200, `restore original settings (status ${restored.status})`, restored.body)
  }
  await q(
    `DELETE FROM attendance_shift_assignments
      WHERE org_id = $1
        AND user_id = ANY($2::text[])`,
    [ORG_ID, [USER, FIXED_USER]],
  )
  await q(
    `DELETE FROM attendance_group_members
      WHERE group_id IN (
        SELECT id FROM attendance_groups WHERE org_id = $1 AND name LIKE $2
      )`,
    [ORG_ID, `${STAMP}%`],
  )
  await q('DELETE FROM attendance_groups WHERE org_id = $1 AND name LIKE $2', [ORG_ID, `${STAMP}%`])
  await q('DELETE FROM attendance_shifts WHERE org_id = $1 AND name LIKE $2', [ORG_ID, `${STAMP}%`])
  await q('DELETE FROM attendance_events WHERE org_id = $1 AND user_id = ANY($2::text[])', [ORG_ID, [USER, FIXED_USER]])
  await q('DELETE FROM attendance_records WHERE org_id = $1 AND user_id = ANY($2::text[])', [ORG_ID, [USER, FIXED_USER]])
  await q('DELETE FROM attendance_requests WHERE org_id = $1 AND user_id = ANY($2::text[])', [ORG_ID, [USER, FIXED_USER]])

  const residue = (await q(
    `SELECT
       (SELECT COUNT(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = ANY($2::text[])) AS assignments,
       (SELECT COUNT(*)::int FROM attendance_shifts WHERE org_id = $1 AND name LIKE $3) AS shifts,
       (SELECT COUNT(*)::int FROM attendance_groups WHERE org_id = $1 AND name LIKE $3) AS groups,
       (SELECT COUNT(*)::int FROM attendance_events WHERE org_id = $1 AND user_id = ANY($2::text[])) AS events,
       (SELECT COUNT(*)::int FROM attendance_records WHERE org_id = $1 AND user_id = ANY($2::text[])) AS records,
       (SELECT COUNT(*)::int FROM attendance_requests WHERE org_id = $1 AND user_id = ANY($2::text[])) AS requests`,
    [ORG_ID, [USER, FIXED_USER], `${STAMP}%`],
  ))[0]
  const clean = Object.values(residue || {}).every(value => Number(value) === 0)
  ok(clean, `cleanup residue = 0 (assignments ${residue?.assignments}, shifts ${residue?.shifts}, groups ${residue?.groups}, events ${residue?.events}, records ${residue?.records}, requests ${residue?.requests})`, residue)
}

main()
  .catch((error) => {
    failures.push(error?.message || String(error))
    console.error(`\nFATAL: ${error?.stack || error}`)
  })
  .finally(async () => {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error?.message || String(error))
      console.error(`\nCLEANUP FATAL: ${error?.stack || error}`)
    } finally {
      await pool.end().catch(() => undefined)
      if (failures.length > 0) {
        console.error(`\n=== FAIL — ${pass} passed, ${failures.length} failed ===  stamp ${STAMP}`)
        process.exitCode = 1
      } else {
        console.log(`\n=== PASS — ${pass} passed, 0 failed ===  stamp ${STAMP}`)
      }
    }
  })
