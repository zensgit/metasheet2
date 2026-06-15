#!/usr/bin/env node
// D5 staging smoke - attendance schedule dispatch / 调度.
//
// Validates the D1-D4 schedule-dispatch chain on staging:
//   D1 schema/envelope / D2 dedicated create/list/read API /
//   D3 final approval writer / D4 admin+employee UI surface.
//
// The smoke drives the real HTTP APIs for dispatch business actions and uses SQL
// only to seed the synthetic target identity, make exact assertions, and clean
// up. It does not flip the tracker by itself; the tracker becomes complete only
// after this script prints
// SCHEDULE_DISPATCH_D5_STAGING_SMOKE_PASS with a real deploy SHA and residue=0.

import pg from 'pg'

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const ORG_ID = process.env.ORG_ID || 'default'
const DEPLOY_SHA = process.env.DEPLOY_SHA || process.env.EXPECTED_DEPLOY_SHA || ''

if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet DEPLOY_SHA=<sha> node scripts/ops/staging-attendance-dispatch-d5-smoke.mjs')
  process.exit(2)
}
if (!DEPLOY_SHA || DEPLOY_SHA === '<fill-from-staging-build>') {
  console.error('FAIL: DEPLOY_SHA is required so the PASS stamp names the staging build that was actually smoked.')
  process.exit(2)
}

const SUFFIX = Date.now().toString(36)
const STAMP = `dispatch-d5-${SUFFIX}`
const ADMIN_USER = process.env.ADMIN_USER_ID || `${STAMP}-admin`
const TARGET_USER = process.env.SMOKE_USER_ID || process.env.TARGET_USER_ID || `${STAMP}-user`
const WORK_DATE = process.env.WORK_DATE || addDays(todayKey(), 21)

let token = process.env.ADMIN_TOKEN || process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let cleanupAllowed = false
let originalSettings = null
let pass = 0
const failures = []

const createdShiftIds = []
const createdScheduleGroupIds = []
const createdFlowIds = []
const createdRequestIds = []
const createdApprovalInstanceIds = []
const createdAssignmentIds = []
const createdMembershipIds = []
const createdUserIds = []

const pool = new pg.Pool({ connectionString: DATABASE_URL })
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

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

function todayKey() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10)
}

function dateOnly(value) {
  if (!value) return null
  if (typeof value === 'string') return value.slice(0, 10)
  return new Date(value).toISOString().slice(0, 10)
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

async function mintAdminToken() {
  const perms = 'attendance:read,attendance:write,attendance:admin,attendance:approve'
  const res = await api(`/api/auth/dev-token?userId=${encodeURIComponent(ADMIN_USER)}&roles=admin&perms=${encodeURIComponent(perms)}`)
  token = res.body?.token || ''
  if (!token) {
    throw new Error(`could not mint dev-token for ${ADMIN_USER} (status ${res.status}); pass ADMIN_TOKEN/SMOKE_TOKEN for this staging environment`)
  }
  console.log('  minted admin dev-token')
}

function assertSyntheticTargetUser() {
  if (String(TARGET_USER).startsWith('dispatch-d5-')) return
  throw new Error(`refusing to run: target user "${TARGET_USER}" is not a synthetic dispatch-d5-* user. Use the default synthetic id; this smoke intentionally never targets real employee history.`)
}

async function resolveToken() {
  if (!token) {
    await mintAdminToken()
    return
  }
  const subject = jwtSubject(token)
  if (subject != null) {
    console.log(`  using supplied admin token (subject ${subject})`)
  }
}

async function preflightDatabase() {
  const row = (await q(
    `SELECT
       to_regclass('public.attendance_schedule_dispatch_requests') IS NOT NULL AS has_dispatch_details,
       to_regclass('public.attendance_schedule_groups') IS NOT NULL AS has_schedule_groups,
       to_regclass('public.attendance_schedule_group_members') IS NOT NULL AS has_schedule_group_members,
       to_regclass('public.attendance_shift_assignments') IS NOT NULL AS has_assignments,
       to_regclass('public.attendance_shifts') IS NOT NULL AS has_shifts,
       to_regclass('public.attendance_requests') IS NOT NULL AS has_requests,
       to_regclass('public.attendance_approval_flows') IS NOT NULL AS has_approval_flows,
       to_regclass('public.users') IS NOT NULL AS has_users,
       to_regclass('public.attendance_events') IS NOT NULL AS has_events,
       to_regclass('public.attendance_records') IS NOT NULL AS has_records,
       to_regclass('public.approval_instances') IS NOT NULL AS has_approval_instances,
       to_regclass('public.approval_records') IS NOT NULL AS has_approval_records,
       to_regclass('public.approval_assignments') IS NOT NULL AS has_approval_assignments`,
  ))[0] || {}
  const ready = Object.values(row).every(value => value === true)
  ok(ready, 'DB cleanup/assertion channel reachable and schedule-dispatch tables exist', row)
  if (!ready) throw new Error('staging DB missing schedule-dispatch tables or unreachable through DATABASE_URL')
}

async function preflightTargetUserEmpty() {
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = $2) AS assignments,
       (SELECT count(*)::int FROM attendance_requests WHERE org_id = $1 AND user_id = $2) AS requests,
       (SELECT count(*)::int FROM attendance_schedule_dispatch_requests WHERE org_id = $1 AND user_id = $2) AS dispatch_details,
       (SELECT count(*)::int FROM attendance_schedule_group_members WHERE org_id = $1 AND user_id = $2) AS memberships,
       (SELECT count(*)::int FROM attendance_events WHERE org_id = $1 AND user_id = $2) AS events,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND user_id = $2) AS records`,
    [ORG_ID, TARGET_USER],
  ))[0] || {}
  const clean = Object.values(row).every(value => Number(value) === 0)
  ok(clean, 'synthetic target user has no pre-existing attendance residue', row)
  if (!clean) {
    throw new Error(`refusing to run against reused target user; clean or choose a fresh dispatch-d5-* subject first: ${JSON.stringify(row)}`)
  }
}

async function verifyApiDbCoherence() {
  const probeName = `${STAMP}-db-coherence-probe`
  const res = await api('/api/attendance/shifts', {
    method: 'POST',
    body: {
      name: probeName,
      timezone: 'UTC',
      workStartTime: '06:00',
      workEndTime: '07:00',
      lateGraceMinutes: 0,
      earlyGraceMinutes: 0,
      roundingMinutes: 1,
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    },
  })
  const id = res.body?.data?.id || res.body?.data?.shift?.id
  ok(res.status === 201 && !!id, `API/DB coherence probe created shift via API (status ${res.status})`, res.body)
  if (!id) throw new Error('API/DB coherence probe could not create a shift')
  try {
    const visible = (await q(
      `SELECT id FROM attendance_shifts WHERE org_id = $1 AND id = $2 AND name = $3`,
      [ORG_ID, id, probeName],
    ))[0]
    ok(visible?.id === id, 'API/DB coherence probe is visible through DATABASE_URL', visible)
    if (visible?.id !== id) throw new Error('DATABASE_URL does not appear to point at the same DB used by BASE_URL')
  } finally {
    const del = await api(`/api/attendance/shifts/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(error => ({ status: 0, body: { error: String(error?.message || error) } }))
    ok(del.status === 200 || del.status === 404, `API/DB coherence probe deleted via API (status ${del.status})`, del.body)
    if (del.status !== 200 && del.status !== 404) {
      throw new Error('API/DB coherence probe cleanup failed; inspect the stamped probe shift before re-running')
    }
  }
}

async function seedTargetUserIdentity() {
  const result = await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, is_active)
     VALUES ($1, $2, 'hash', $3, 'user', true)
     ON CONFLICT (id) DO NOTHING`,
    [TARGET_USER, `${TARGET_USER}@example.test`, TARGET_USER],
  )
  if (Number(result.rowCount || 0) > 0) createdUserIds.push(TARGET_USER)
  const row = (await q('SELECT id FROM users WHERE id = $1', [TARGET_USER]))[0]
  ok(row?.id === TARGET_USER, 'synthetic target user identity exists for staging smoke', row)
  if (row?.id !== TARGET_USER) throw new Error('target user identity was not created')
}

async function saveSettings(update) {
  const res = await api('/api/attendance/settings', { method: 'PUT', body: update })
  ok(res.status === 200, `save settings ${Object.keys(update).join(',')} (status ${res.status})`, res.body)
  if (res.status !== 200) throw new Error('settings update failed')
  return res.body?.data || {}
}

async function createShift() {
  const res = await api('/api/attendance/shifts', {
    method: 'POST',
    body: {
      name: `${STAMP}-target-shift`,
      timezone: 'UTC',
      workStartTime: '09:15',
      workEndTime: '17:45',
      lateGraceMinutes: 0,
      earlyGraceMinutes: 0,
      roundingMinutes: 1,
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    },
  })
  const id = res.body?.data?.id || res.body?.data?.shift?.id
  ok(res.status === 201 && !!id, `create target shift (status ${res.status})`, res.body)
  if (!id) throw new Error('target shift was not created')
  createdShiftIds.push(id)
  return id
}

async function createScheduleGroup() {
  const res = await api('/api/attendance/schedule-groups', {
    method: 'POST',
    body: {
      name: `${STAMP}-target-group`,
      code: `${STAMP}-sg`,
      description: `${STAMP} schedule-dispatch staging smoke target`,
      departmentRef: `${STAMP}-dept`,
      source: 'manual',
      isActive: true,
    },
  })
  const id = res.body?.data?.id
  ok((res.status === 200 || res.status === 201) && !!id, `create target schedule group (status ${res.status})`, res.body)
  if (!id) throw new Error('target schedule group was not created')
  createdScheduleGroupIds.push(id)
  return id
}

async function createApprovalFlow() {
  const res = await api('/api/attendance/approval-flows', {
    method: 'POST',
    body: {
      name: `${STAMP}-schedule-dispatch-flow`,
      requestType: 'schedule_dispatch',
      isActive: true,
      steps: [],
    },
  })
  const id = res.body?.data?.id || res.body?.data?.flow?.id
  ok((res.status === 200 || res.status === 201) && !!id, `create schedule_dispatch approval flow (status ${res.status})`, res.body)
  if (!id) throw new Error('schedule_dispatch approval flow was not created')
  createdFlowIds.push(id)
  return id
}

async function createScheduleDispatchRequest({ scheduleGroupId, shiftId, approvalFlowId }) {
  const res = await api('/api/attendance/schedule-dispatch-requests', {
    method: 'POST',
    body: {
      userId: TARGET_USER,
      targetScheduleGroupId: scheduleGroupId,
      targetShiftId: shiftId,
      startDate: WORK_DATE,
      endDate: WORK_DATE,
      slotIndex: 0,
      approvalFlowId,
      reason: `${STAMP} staging smoke`,
    },
  })
  const requestId = res.body?.data?.request?.id
  ok(res.status === 201 && !!requestId, `create schedule-dispatch request (status ${res.status})`, res.body)
  if (!requestId) throw new Error('schedule-dispatch request was not created')
  createdRequestIds.push(requestId)
  const detail = res.body?.data?.scheduleDispatch
  ok(detail?.requestId === requestId
    && detail?.userId === TARGET_USER
    && detail?.targetScheduleGroupId === scheduleGroupId
    && detail?.targetShiftId === shiftId
    && detail?.startDate === WORK_DATE
    && detail?.endDate === WORK_DATE
    && detail?.publishStatus === 'pending',
    'create response maps parent/detail fields to dispatched user and date window', detail)
  const requestRow = (await q(
    `SELECT approval_instance_id FROM attendance_requests WHERE org_id = $1 AND id = $2`,
    [ORG_ID, requestId],
  ))[0]
  if (requestRow?.approval_instance_id) createdApprovalInstanceIds.push(String(requestRow.approval_instance_id))
  return requestId
}

async function effectiveItem() {
  const res = await api(`/api/attendance/effective-calendar?from=${WORK_DATE}&to=${WORK_DATE}&userId=${encodeURIComponent(TARGET_USER)}`)
  ok(res.status === 200, `effective-calendar target user/date returns 200 (got ${res.status})`, res.body)
  return res.body?.data?.items?.[0] || null
}

function effectiveSlots(item) {
  return Array.isArray(item?.effective?.slots) ? item.effective.slots : []
}

function slotShiftId(slot) {
  return slot?.shiftId || slot?.shift_id || null
}

function effectiveShiftId(item) {
  return item?.effective?.shiftId || item?.effective?.shift_id || slotShiftId(effectiveSlots(item)[0]) || null
}

function effectiveSource(item) {
  return item?.effective?.source ?? null
}

async function main() {
  console.log(`D5 schedule-dispatch staging smoke @ ${BASE_URL} (org ${ORG_ID}, target ${TARGET_USER}, workDate ${WORK_DATE}, stamp ${STAMP})`)
  assertSyntheticTargetUser()
  await preflightDatabase()
  await resolveToken()

  const settingsRes = await api('/api/attendance/settings')
  ok(settingsRes.status === 200, `auth: GET settings 200 (got ${settingsRes.status})`, settingsRes.body)
  if (settingsRes.status !== 200) throw new Error('cannot authenticate to staging')
  originalSettings = settingsRes.body?.data || {}
  await preflightTargetUserEmpty()
  await verifyApiDbCoherence()
  cleanupAllowed = true

  await saveSettings({
    shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
    shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
    multiShiftDay: { enabled: false, maxSlots: 1 },
  })

  await seedTargetUserIdentity()
  const targetShiftId = await createShift()
  const targetScheduleGroupId = await createScheduleGroup()
  const approvalFlowId = await createApprovalFlow()

  const before = await effectiveItem()
  ok(effectiveShiftId(before) !== targetShiftId,
    'before approval, effective-calendar does not expose the dispatch target shift id', before?.effective)

  const requestId = await createScheduleDispatchRequest({
    scheduleGroupId: targetScheduleGroupId,
    shiftId: targetShiftId,
    approvalFlowId,
  })

  const pending = (await q(
    `SELECT d.publish_status, d.assignment_ids, d.membership_id, d.finalized_at,
            r.status AS request_status, r.user_id, r.work_date, r.request_type
       FROM attendance_schedule_dispatch_requests d
       JOIN attendance_requests r ON r.id = d.request_id
      WHERE d.org_id = $1 AND d.request_id = $2`,
    [ORG_ID, requestId],
  ))[0]
  ok(pending?.request_status === 'pending'
    && pending?.publish_status === 'pending'
    && pending?.user_id === TARGET_USER
    && dateOnly(pending?.work_date) === WORK_DATE
    && pending?.request_type === 'schedule_dispatch'
    && Array.isArray(pending?.assignment_ids)
    && pending.assignment_ids.length === 0
    && pending?.membership_id == null
    && pending?.finalized_at == null,
    'pending request has no assignment or membership side effects', pending)

  const approve = await api(`/api/attendance/requests/${requestId}/approve`, {
    method: 'POST',
    body: { comment: `${STAMP} final approve` },
  })
  ok(approve.status === 200 && (approve.body?.data?.status === 'approved' || approve.body?.data?.request?.status === 'approved'),
    `admin final approval succeeds (status ${approve.status})`, approve.body)

  const afterApprove = (await q(
    `SELECT r.status AS request_status, ai.status AS approval_status, d.publish_status,
            d.assignment_ids, d.membership_id, d.finalized_at, d.source_key,
            r.metadata -> 'scheduleDispatchFinalization' AS finalization
       FROM attendance_schedule_dispatch_requests d
       JOIN attendance_requests r ON r.id = d.request_id
       LEFT JOIN approval_instances ai ON ai.id = r.approval_instance_id
      WHERE d.org_id = $1 AND d.request_id = $2`,
    [ORG_ID, requestId],
  ))[0]
  const assignmentIds = Array.isArray(afterApprove?.assignment_ids)
    ? afterApprove.assignment_ids.map(String)
    : []
  if (assignmentIds.length) createdAssignmentIds.push(...assignmentIds)
  if (afterApprove?.membership_id) createdMembershipIds.push(String(afterApprove.membership_id))
  const expectedSourceKey = `schedule_dispatch:${TARGET_USER}:${targetScheduleGroupId}:${WORK_DATE}:${WORK_DATE}:0`
  ok(afterApprove?.request_status === 'approved'
    && afterApprove?.approval_status === 'approved'
    && afterApprove?.publish_status === 'published'
    && afterApprove?.source_key === expectedSourceKey
    && assignmentIds.length === 1
    && !!afterApprove?.membership_id
    && !!afterApprove?.finalized_at,
    'detail row finalized with assignment id, membership id, and deterministic source key', afterApprove)
  ok(Array.isArray(afterApprove?.finalization?.assignmentIds)
    && afterApprove.finalization.assignmentIds.map(String).join(',') === assignmentIds.join(',')
    && String(afterApprove.finalization.membershipId) === String(afterApprove.membership_id),
    'attendance_requests metadata records the dispatch finalization ids', afterApprove?.finalization)

  const assignment = (await q(
    `SELECT id, user_id, shift_id, slot_index, start_date, end_date, is_active,
            publish_status, published_by, locked_at, assignment_kind,
            producer_type, producer_ref_id, producer_key, producer_run_id
       FROM attendance_shift_assignments
      WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid`,
    [ORG_ID, requestId],
  ))[0]
  ok(assignment
    && assignment.id === assignmentIds[0]
    && assignment.user_id === TARGET_USER
    && assignment.shift_id === targetShiftId
    && Number(assignment.slot_index) === 0
    && dateOnly(assignment.start_date) === WORK_DATE
    && dateOnly(assignment.end_date) === WORK_DATE
    && assignment.is_active === true
    && assignment.publish_status === 'published'
    && assignment.assignment_kind === 'regular'
    && assignment.producer_type === 'schedule_dispatch'
    && String(assignment.producer_ref_id) === requestId
    && assignment.producer_key === expectedSourceKey
    && String(assignment.producer_run_id) === requestId
    && !!assignment.locked_at,
    'published schedule-dispatch assignment has exact target, date, and provenance', assignment)

  const membership = (await q(
    `SELECT id, schedule_group_id, user_id, effective_from, effective_to, role, source
       FROM attendance_schedule_group_members
      WHERE org_id = $1 AND id = $2`,
    [ORG_ID, afterApprove?.membership_id],
  ))[0]
  ok(membership
    && membership.id === afterApprove?.membership_id
    && membership.schedule_group_id === targetScheduleGroupId
    && membership.user_id === TARGET_USER
    && dateOnly(membership.effective_from) === WORK_DATE
    && dateOnly(membership.effective_to) === WORK_DATE
    && membership.role === 'member'
    && membership.source === 'schedule_dispatch',
    'schedule-dispatch membership window is present with exact target group/user/date', membership)

  const after = await effectiveItem()
  ok(effectiveSource(after) === 'shift',
    'effective-calendar resolves through the shift path after approval', {
      expectedShiftId: targetShiftId,
      exposedShiftId: effectiveShiftId(after),
      effective: after?.effective,
    })

  const replay = await api(`/api/attendance/requests/${requestId}/approve`, {
    method: 'POST',
    body: { comment: `${STAMP} replay` },
  })
  ok(replay.status === 400 && replay.body?.error?.code === 'INVALID_STATUS',
    `replay approval is rejected without duplicate materialization (status ${replay.status})`, replay.body)
  const countsAfterReplay = (await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND producer_type = 'schedule_dispatch' AND producer_ref_id = $2::uuid) AS assignment_count,
       (SELECT count(*)::int FROM attendance_schedule_group_members WHERE org_id = $1 AND user_id = $3 AND source = 'schedule_dispatch') AS membership_count,
       (SELECT count(*)::int FROM attendance_events WHERE org_id = $1 AND meta ->> 'requestId' = $2::text) AS event_count`,
    [ORG_ID, requestId, TARGET_USER],
  ))[0]
  ok(Number(countsAfterReplay?.assignment_count) === 1
    && Number(countsAfterReplay?.membership_count) === 1
    && Number(countsAfterReplay?.event_count) === 0,
    'replay leaves one assignment, one membership, and no generic adjustment event', countsAfterReplay)
}

async function cleanup() {
  console.log('\n--- restore + cleanup ---')
  if (!cleanupAllowed) {
    console.log('  cleanup SKIPPED - safety gate not satisfied; no API mutations should have happened.')
    return
  }

  async function cleanupStep(label, text, params = []) {
    try {
      await q(text, params)
    } catch (error) {
      failures.push(`cleanup ${label} failed: ${error?.message || error}`)
      console.error(`  FAIL  cleanup ${label} failed - ${error?.message || error}`)
    }
  }

  try {
    if (originalSettings) {
      const restored = await api('/api/attendance/settings', { method: 'PUT', body: originalSettings })
      ok(restored.status === 200, `restore original settings (status ${restored.status})`, restored.body)
    }
  } catch (error) {
    failures.push(`settings restore failed: ${error?.message || error}`)
    console.error(`  FAIL  settings restore failed - ${error?.message || error}`)
  }

  const requestBusinessKeys = createdRequestIds.map(id => `attendance-request:${id}`)
  const dispatchRows = await q(
    `SELECT request_id, assignment_ids, membership_id, source_key
       FROM attendance_schedule_dispatch_requests
      WHERE org_id = $1
        AND request_id = ANY($2::uuid[])`,
    [ORG_ID, createdRequestIds],
  ).catch(() => [])
  const linkedAssignmentIds = [...new Set([
    ...createdAssignmentIds,
    ...dispatchRows.flatMap(row => Array.isArray(row.assignment_ids) ? row.assignment_ids.map(String) : []),
  ])]
  const linkedMembershipIds = [...new Set([
    ...createdMembershipIds,
    ...dispatchRows.map(row => row.membership_id).filter(Boolean).map(String),
  ])]
  const approvalRows = await q(
    `SELECT id
       FROM approval_instances
      WHERE id = ANY($1::text[])
         OR business_key = ANY($2::text[])`,
    [createdApprovalInstanceIds, requestBusinessKeys],
  ).catch(() => [])
  const approvalInstanceIds = [...new Set([
    ...createdApprovalInstanceIds,
    ...approvalRows.map(row => String(row.id)),
  ])]

  await cleanupStep(
    'approval records',
    `DELETE FROM approval_records
      WHERE instance_id = ANY($1::text[])`,
    [approvalInstanceIds],
  )
  await cleanupStep(
    'approval assignments',
    `DELETE FROM approval_assignments
      WHERE instance_id = ANY($1::text[])`,
    [approvalInstanceIds],
  )
  await cleanupStep(
    'schedule-dispatch details',
    `DELETE FROM attendance_schedule_dispatch_requests
      WHERE org_id = $1
        AND request_id = ANY($2::uuid[])`,
    [ORG_ID, createdRequestIds],
  )
  await cleanupStep(
    'attendance requests',
    `DELETE FROM attendance_requests
      WHERE org_id = $1
        AND id = ANY($2::uuid[])`,
    [ORG_ID, createdRequestIds],
  )
  await cleanupStep(
    'approval instances',
    `DELETE FROM approval_instances
      WHERE id = ANY($1::text[])
         OR business_key = ANY($2::text[])`,
    [approvalInstanceIds, requestBusinessKeys],
  )
  await cleanupStep(
    'schedule-dispatch assignments',
    `DELETE FROM attendance_shift_assignments
      WHERE org_id = $1
        AND (id = ANY($2::uuid[])
             OR producer_ref_id = ANY($3::uuid[])
             OR producer_key = ANY($4::text[]))`,
    [ORG_ID, linkedAssignmentIds, createdRequestIds, dispatchRows.map(row => row.source_key).filter(Boolean)],
  )
  await cleanupStep(
    'schedule-dispatch memberships',
    `DELETE FROM attendance_schedule_group_members
      WHERE org_id = $1
        AND (id = ANY($2::uuid[])
             OR (schedule_group_id = ANY($3::uuid[]) AND source = 'schedule_dispatch'))`,
    [ORG_ID, linkedMembershipIds, createdScheduleGroupIds],
  )
  await cleanupStep(
    'approval flows',
    `DELETE FROM attendance_approval_flows
      WHERE org_id = $1
        AND (id = ANY($2::uuid[]) OR name LIKE $3)`,
    [ORG_ID, createdFlowIds, `${STAMP}-%`],
  )
  await cleanupStep(
    'schedule groups',
    `DELETE FROM attendance_schedule_groups
      WHERE org_id = $1
        AND (id = ANY($2::uuid[]) OR name LIKE $3 OR code LIKE $3)`,
    [ORG_ID, createdScheduleGroupIds, `${STAMP}-%`],
  )
  await cleanupStep(
    'shifts',
    `DELETE FROM attendance_shifts
      WHERE org_id = $1
        AND (id = ANY($2::uuid[]) OR name LIKE $3)`,
    [ORG_ID, createdShiftIds, `${STAMP}-%`],
  )
  await cleanupStep(
    'target user roles',
    `DELETE FROM user_roles
      WHERE user_id = ANY($1::text[])`,
    [createdUserIds],
  )
  await cleanupStep(
    'target users',
    `DELETE FROM users
      WHERE id = ANY($1::text[])`,
    [createdUserIds],
  )

  const residue = (await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_shift_assignments
         WHERE org_id = $1
           AND (id = ANY($4::uuid[])
                OR producer_ref_id = ANY($5::uuid[])
                OR (user_id = $2 AND shift_id = ANY($6::uuid[])))) AS assignments,
       (SELECT count(*)::int FROM attendance_schedule_group_members
         WHERE org_id = $1
           AND (id = ANY($7::uuid[])
                OR (schedule_group_id = ANY($8::uuid[]) AND source = 'schedule_dispatch'))) AS memberships,
       (SELECT count(*)::int FROM attendance_schedule_dispatch_requests WHERE org_id = $1 AND request_id = ANY($5::uuid[])) AS dispatch_details,
       (SELECT count(*)::int FROM attendance_requests WHERE org_id = $1 AND id = ANY($5::uuid[])) AS requests,
       (SELECT count(*)::int FROM approval_instances WHERE id = ANY($9::text[]) OR business_key = ANY($10::text[])) AS approval_instances,
       (SELECT count(*)::int FROM approval_records WHERE instance_id = ANY($9::text[])) AS approval_records,
       (SELECT count(*)::int FROM approval_assignments WHERE instance_id = ANY($9::text[])) AS approval_assignments,
       (SELECT count(*)::int FROM attendance_events WHERE org_id = $1 AND user_id = $2) AS events,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND user_id = $2) AS records,
       (SELECT count(*)::int FROM attendance_shifts WHERE org_id = $1 AND name LIKE $3) AS shifts,
       (SELECT count(*)::int FROM attendance_schedule_groups WHERE org_id = $1 AND name LIKE $3) AS schedule_groups,
       (SELECT count(*)::int FROM attendance_approval_flows WHERE org_id = $1 AND name LIKE $3) AS flows,
       (SELECT count(*)::int FROM users WHERE id = ANY($11::text[])) AS users`,
    [
      ORG_ID,
      TARGET_USER,
      `${STAMP}-%`,
      linkedAssignmentIds,
      createdRequestIds,
      createdShiftIds,
      linkedMembershipIds,
      createdScheduleGroupIds,
      approvalInstanceIds,
      requestBusinessKeys,
      createdUserIds,
    ],
  ))[0] || {}
  const clean = Object.values(residue).every(value => Number(value) === 0)
  ok(clean, `cleanup residue = 0 (${Object.entries(residue).map(([key, value]) => `${key} ${value}`).join(', ')})`, residue)
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
  console.error(`\n=== FAIL - ${pass} passed, ${failures.length} failed ===  stamp ${STAMP}`)
  process.exit(1)
}

console.log(`\n=== PASS - ${pass} passed, 0 failed ===  stamp ${STAMP}`)
console.log(`SCHEDULE_DISPATCH_D5_STAGING_SMOKE_PASS deploy=${DEPLOY_SHA} stamp=${STAMP} workDate=${WORK_DATE} targetUser=${TARGET_USER} residue=0`)
