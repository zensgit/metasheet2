#!/usr/bin/env node
// M5 staging smoke — one-day multi-shift scheduling.
//
// Drives the deployed staging HTTP API and uses SQL only for exact assertions
// and cleanup. It restores attendance settings and deletes rows bearing the
// unique synthetic user/group/shift prefix.

import { randomUUID } from 'crypto'
import pg from 'pg'

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const ORG_ID = process.env.ORG_ID || 'default'
if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://u@127.0.0.1:5432/metasheet [SMOKE_TOKEN=<jwt>] node scripts/ops/staging-attendance-multi-shift-m5-smoke.mjs')
  process.exit(2)
}

const SUFFIX = Date.now().toString(36)
const STAMP = `multi-shift-m5-${SUFFIX}`
const USER_PREFIX = `multishift-${SUFFIX}`
let token = process.env.SMOKE_TOKEN || process.env.TOKEN || ''
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

const WORK_DATE = process.env.WORK_DATE || addDays(todayKey(), 28)

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
  const res = await api(`/api/auth/dev-token?userId=${encodeURIComponent(`${USER_PREFIX}-admin`)}&roles=admin&perms=${encodeURIComponent(perms)}`)
  token = res.body?.token || ''
  if (!token) {
    throw new Error(`could not mint dev-token (status ${res.status}) — pass SMOKE_TOKEN for staging with dev-token disabled`)
  }
  console.log('  minted dev-token for synthetic multi-shift smoke admin')
}

async function saveSettings(update) {
  const res = await api('/api/attendance/settings', { method: 'PUT', body: update })
  ok(res.status === 200, `save settings ${Object.keys(update).join(',')} (status ${res.status})`, res.body)
  if (res.status !== 200) throw new Error('settings update failed')
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

async function createAssignment(userId, shiftId, slotIndex, date = WORK_DATE) {
  const res = await api('/api/attendance/assignments', {
    method: 'POST',
    body: { userId, shiftId, startDate: date, endDate: date, isActive: true, slotIndex },
  })
  return res
}

function expectAssignmentConflict(res, label) {
  const error = res.body?.error || {}
  ok(
    res.status === 409
      && error.code === 'ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT'
      && error.details?.conflictType === 'shift_assignment_overlap',
    label,
    res.body,
  )
}

async function effectiveItem(userId, date = WORK_DATE) {
  const res = await api(`/api/attendance/effective-calendar?from=${date}&to=${date}&userId=${encodeURIComponent(userId)}`)
  ok(res.status === 200, `effective-calendar ${userId} ${date} returns 200 (got ${res.status})`, res.body)
  return res.body?.data?.items?.[0] || null
}

function effectiveSlots(item) {
  return Array.isArray(item?.effective?.slots) ? item.effective.slots : []
}

function slotIndex(slot) {
  return Number(slot?.slotIndex ?? slot?.slot_index ?? 0)
}

function slotShiftId(slot) {
  return slot?.shiftId || slot?.shift_id || null
}

function plannedMinutes(value) {
  return Number(value?.plannedMinutes ?? value?.planned_minutes ?? 0)
}

async function assertMultiSlotEffective(userId, expectedShiftIds, label) {
  const item = await effectiveItem(userId)
  const slots = effectiveSlots(item)
  ok(slots.map(slotIndex).join(',') === '0,1', `${label}: effective slots are ordered [0,1]`, slots)
  ok(slots.map(slotShiftId).join(',') === expectedShiftIds.join(','), `${label}: effective slot shifts match`, slots)
  ok(slots.map(plannedMinutes).join(',') === '240,240', `${label}: per-slot planned minutes are [240,240]`, slots)
  ok(plannedMinutes(item?.effective) === 480, `${label}: total planned minutes is 480`, item?.effective)
}

async function createFixedGroup(userId) {
  const groupRes = await api('/api/attendance/groups', {
    method: 'POST',
    body: {
      name: `${STAMP}-fixed-group`,
      timezone: 'UTC',
      attendanceType: 'fixed_shift',
      description: 'multi-shift staging smoke fixed compatibility',
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

async function fixedSchedule(groupId, shiftId, verb) {
  const res = await api(`/api/attendance/groups/${groupId}/fixed-schedule/${verb}`, {
    method: 'POST',
    body: { shiftId, startDate: WORK_DATE, endDate: WORK_DATE },
  })
  const expected = verb === 'apply' ? 201 : 200
  ok(res.status === expected, `fixed-schedule ${verb} (status ${res.status})`, res.body)
  return res
}

async function assignmentRows(userId) {
  return q(
    `SELECT shift_id, slot_index, producer_type
       FROM attendance_shift_assignments
      WHERE org_id = $1
        AND user_id = $2
        AND start_date <= $3::date
        AND COALESCE(end_date, start_date) >= $3::date
        AND COALESCE(is_active, true) = true
      ORDER BY slot_index ASC`,
    [ORG_ID, userId, WORK_DATE],
  )
}

function assertFixedRowsPreserveNonZeroSlot(rows, morningShiftId, eveningShiftId, label) {
  ok(rows.map(row => Number(row.slot_index)).join(',') === '0,1',
    `${label}: rows remain slot 0 + slot 1`, rows)
  const slot0 = rows.find(row => Number(row.slot_index) === 0)
  const slot1 = rows.find(row => Number(row.slot_index) === 1)
  ok(slot0?.shift_id === morningShiftId && slot0?.producer_type === 'attendance_group_fixed_schedule',
    `${label}: slot 0 is the fixed-schedule managed morning row`, rows)
  ok(slot1?.shift_id === eveningShiftId && slot1?.producer_type == null,
    `${label}: slot 1 preserves the original direct evening row`, rows)
}

async function createScheduledGroup(userId) {
  const groupRes = await api('/api/attendance/groups', {
    method: 'POST',
    body: {
      name: `${STAMP}-scheduled-group`,
      timezone: 'UTC',
      attendanceType: 'scheduled_shift',
      description: 'multi-shift staging smoke auto-shift compatibility',
    },
  })
  const groupId = groupRes.body?.data?.id
  ok(groupRes.status === 200 && !!groupId, `create scheduled group (status ${groupRes.status})`, groupRes.body)
  if (!groupId) throw new Error('scheduled group was not created')
  const memberRes = await api(`/api/attendance/groups/${groupId}/members`, {
    method: 'POST',
    body: { userIds: [userId] },
  })
  ok(memberRes.status === 200, `add scheduled group member (status ${memberRes.status})`, memberRes.body)
  return groupId
}

async function autoShiftApplyExistingSlot(userId, candidateShiftId) {
  const res = await api('/api/attendance/auto-shift-matching/apply', {
    method: 'POST',
    body: {
      items: [
        {
          userId,
          workDate: WORK_DATE,
          candidateShiftId,
          evidence: { eventIds: [`${STAMP}-synthetic-evidence`] },
        },
      ],
    },
  })
  ok(res.status === 200, `auto-shift apply returns 200 for existing slot user (status ${res.status})`, res.body)
  const skipped = res.body?.data?.skipped || []
  ok(
    Array.isArray(skipped)
      && skipped.length === 1
      && skipped[0]?.userId === userId
      && skipped[0]?.reason === 'already_scheduled',
    'auto-shift skips a user/day with an existing non-zero slot',
    res.body,
  )
}

async function cleanup() {
  let restoreStatus = null
  if (originalSettings) {
    const restoreRes = await api('/api/attendance/settings', { method: 'PUT', body: originalSettings }).catch(() => null)
    restoreStatus = restoreRes?.status ?? null
  }
  await q('DELETE FROM attendance_records WHERE org_id = $1 AND user_id LIKE $2', [ORG_ID, `${USER_PREFIX}%`])
  await q('DELETE FROM attendance_events WHERE org_id = $1 AND user_id LIKE $2', [ORG_ID, `${USER_PREFIX}%`])
  await q(
    `DELETE FROM attendance_shift_assignments
      WHERE org_id = $1
        AND (user_id LIKE $2 OR producer_key LIKE $3 OR producer_run_id LIKE $3)`,
    [ORG_ID, `${USER_PREFIX}%`, `${STAMP}%`],
  )
  await q(
    `DELETE FROM attendance_group_members
      WHERE org_id = $1
        AND (user_id LIKE $2 OR group_id IN (SELECT id FROM attendance_groups WHERE org_id = $1 AND name LIKE $3))`,
    [ORG_ID, `${USER_PREFIX}%`, `${STAMP}%`],
  )
  await q('DELETE FROM attendance_groups WHERE org_id = $1 AND name LIKE $2', [ORG_ID, `${STAMP}%`])
  await q('DELETE FROM attendance_rotation_assignments WHERE org_id = $1 AND user_id LIKE $2', [ORG_ID, `${USER_PREFIX}%`])
  await q('DELETE FROM attendance_rotation_rules WHERE org_id = $1 AND name LIKE $2', [ORG_ID, `${STAMP}%`])
  await q('DELETE FROM attendance_shifts WHERE org_id = $1 AND name LIKE $2', [ORG_ID, `${STAMP}%`])
  return { restoreStatus }
}

async function residueCounts() {
  const rows = await q(
    `SELECT
      (SELECT COUNT(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND user_id LIKE $2) AS assignments,
      (SELECT COUNT(*)::int FROM attendance_shifts WHERE org_id = $1 AND name LIKE $3) AS shifts,
      (SELECT COUNT(*)::int FROM attendance_groups WHERE org_id = $1 AND name LIKE $3) AS groups,
      (SELECT COUNT(*)::int FROM attendance_events WHERE org_id = $1 AND user_id LIKE $2) AS events,
      (SELECT COUNT(*)::int FROM attendance_records WHERE org_id = $1 AND user_id LIKE $2) AS records`,
    [ORG_ID, `${USER_PREFIX}%`, `${STAMP}%`],
  )
  return rows[0] || {}
}

async function main() {
  console.log(`M5 multi-shift staging smoke @ ${BASE_URL} (prefix ${USER_PREFIX}, stamp ${STAMP})`)
  await ensureToken()

  const settingsRes = await api('/api/attendance/settings')
  ok(settingsRes.status === 200, `auth: GET settings 200 (got ${settingsRes.status})`, settingsRes.body)
  originalSettings = settingsRes.body?.data || {}

  const morningShiftId = await createShift('morning', '08:00', '12:00')
  const eveningShiftId = await createShift('evening', '13:00', '17:00')
  const overlapShiftId = await createShift('overlap', '11:00', '15:00')

  await saveSettings({
    shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
    shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
    multiShiftDay: { enabled: true, maxSlots: 3 },
    autoShiftMatching: {
      enabled: true,
      mode: 'apply',
      maxToleranceMinutes: 30,
      minConfidenceToApply: 'high',
    },
  })

  const multiUser = `${USER_PREFIX}-direct`
  const slot0Res = await createAssignment(multiUser, morningShiftId, 0)
  const slot0 = slot0Res.body?.data?.assignment
  ok(slot0Res.status === 201 && slot0?.slotIndex === 0, 'create direct slot 0 assignment', slot0Res.body)
  const slot1Res = await createAssignment(multiUser, eveningShiftId, 1)
  const slot1 = slot1Res.body?.data?.assignment
  ok(slot1Res.status === 201 && slot1?.slotIndex === 1, 'create direct slot 1 assignment', slot1Res.body)

  await assertMultiSlotEffective(multiUser, [morningShiftId, eveningShiftId], 'direct multi-slot')

  const previewRes = await api('/api/attendance/comprehensive-hours/preview', {
    method: 'POST',
    body: {
      metric: 'planned',
      enforcement: 'warn',
      capMinutes: 1000,
      userId: multiUser,
      period: { type: 'custom_range', from: WORK_DATE, to: WORK_DATE },
    },
  })
  ok(previewRes.status === 200, `comprehensive planned preview returns 200 (got ${previewRes.status})`, previewRes.body)
  const previewRow = previewRes.body?.data?.rows?.[0]
  ok(previewRow?.userId === multiUser && Number(previewRow?.plannedMinutes ?? previewRow?.minutes ?? 0) === 480,
    'comprehensive planned preview sums both slots to 480', previewRes.body)

  expectAssignmentConflict(await createAssignment(multiUser, eveningShiftId, 1), 'same slot overlap rejects')
  expectAssignmentConflict(await createAssignment(multiUser, overlapShiftId, 2), 'different slot with overlapping shift window rejects')

  const fixedUser = `${USER_PREFIX}-fixed`
  const fixedSlot1Res = await createAssignment(fixedUser, eveningShiftId, 1)
  ok(fixedSlot1Res.status === 201, 'seed fixed user non-zero slot before fixed apply', fixedSlot1Res.body)
  const fixedGroupId = await createFixedGroup(fixedUser)
  await fixedSchedule(fixedGroupId, morningShiftId, 'apply')
  let fixedRows = await assignmentRows(fixedUser)
  assertFixedRowsPreserveNonZeroSlot(fixedRows, morningShiftId, eveningShiftId, 'fixed apply')
  await assertMultiSlotEffective(fixedUser, [morningShiftId, eveningShiftId], 'fixed apply multi-slot')
  await fixedSchedule(fixedGroupId, morningShiftId, 'rebuild')
  fixedRows = await assignmentRows(fixedUser)
  assertFixedRowsPreserveNonZeroSlot(fixedRows, morningShiftId, eveningShiftId, 'fixed rebuild')
  await assertMultiSlotEffective(fixedUser, [morningShiftId, eveningShiftId], 'fixed rebuild multi-slot')

  const autoUser = `${USER_PREFIX}-auto`
  await createScheduledGroup(autoUser)
  const autoSlot1Res = await createAssignment(autoUser, eveningShiftId, 1)
  ok(autoSlot1Res.status === 201, 'seed auto-shift user non-zero slot', autoSlot1Res.body)
  await autoShiftApplyExistingSlot(autoUser, morningShiftId)
  const autoRows = await assignmentRows(autoUser)
  ok(autoRows.length === 1 && Number(autoRows[0]?.slot_index) === 1 && autoRows[0]?.producer_type == null,
    'auto-shift compatibility leaves the existing slot 1 row untouched', autoRows)

  console.log('\n--- restore + cleanup ---')
  const cleanupResult = await cleanup()
  ok(cleanupResult.restoreStatus === 200, `restore original settings (status ${cleanupResult.restoreStatus})`)
  const residue = await residueCounts()
  ok(
    Number(residue.assignments || 0) === 0
      && Number(residue.shifts || 0) === 0
      && Number(residue.groups || 0) === 0
      && Number(residue.events || 0) === 0
      && Number(residue.records || 0) === 0,
    `cleanup residue = 0 (assignments ${residue.assignments}, shifts ${residue.shifts}, groups ${residue.groups}, events ${residue.events}, records ${residue.records})`,
    residue,
  )

  if (failures.length) {
    console.error(`\n=== FAIL — ${pass} passed, ${failures.length} failed ===`)
    process.exit(1)
  }
  console.log(`\n=== PASS — ${pass} passed, 0 failed ===  stamp ${STAMP}`)
}

main()
  .catch(async (error) => {
    console.error(`\n=== FAIL — ${error?.stack || error?.message || error} ===`)
    try {
      console.error('\n--- restore + cleanup after failure ---')
      await cleanup()
      const residue = await residueCounts()
      console.error(`cleanup residue after failure: ${JSON.stringify(residue)}`)
    } catch (cleanupError) {
      console.error(`cleanup failed: ${cleanupError?.stack || cleanupError?.message || cleanupError}`)
    }
    process.exit(1)
  })
  .finally(async () => {
    await pool.end().catch(() => undefined)
  })
