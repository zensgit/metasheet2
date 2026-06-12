#!/usr/bin/env node
// SW5 staging smoke - attendance shift swap.
//
// Validates the SW1-SW4 shift-swap chain on staging:
//   SW1 schema/envelope / SW2 dedicated create/consent API /
//   SW3 final approval writer / SW4 real admin/employee UI surface.
//
// The smoke drives the real HTTP APIs for business actions and uses SQL only for
// exact assertions and cleanup. It does not flip the tracker by itself; the
// tracker becomes complete only after this script prints SHIFT_SWAP_SW5_STAGING_SMOKE_PASS
// with a real deploy SHA and cleanup residue=0.

import pg from 'pg'

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const ORG_ID = process.env.ORG_ID || 'default'
const DEPLOY_SHA = process.env.DEPLOY_SHA || ''

if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet DEPLOY_SHA=<sha> node scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs')
  process.exit(2)
}
if (!DEPLOY_SHA || DEPLOY_SHA === '<fill-from-staging-build>') {
  console.error('FAIL: DEPLOY_SHA is required so the PASS stamp names the staging build that was actually smoked.')
  process.exit(2)
}

const SUFFIX = Date.now().toString(36)
const STAMP = `shift-swap-sw5-${SUFFIX}`
const USER_PREFIX = `shiftswap-sw5-${SUFFIX}`
const ADMIN_USER = process.env.ADMIN_USER_ID || `${USER_PREFIX}-admin`
const REQUESTER_USER = process.env.REQUESTER_USER_ID || `${USER_PREFIX}-requester`
const COUNTERPARTY_USER = process.env.COUNTERPARTY_USER_ID || `${USER_PREFIX}-counterparty`

let adminToken = process.env.ADMIN_TOKEN || process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let requesterToken = process.env.REQUESTER_TOKEN || ''
let counterpartyToken = process.env.COUNTERPARTY_TOKEN || ''

let cleanupAllowed = false
let originalSettings = null
let pass = 0
const failures = []
const createdShiftIds = []
const createdAssignmentIds = []
const createdFlowIds = []
const createdRequestIds = []
const createdApprovalInstanceIds = []

const pool = new pg.Pool({ connectionString: DATABASE_URL })
const q = (text, params = []) => pool.query(text, params).then(result => result.rows)

function ok(condition, label, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failures.push(label)
  const extra = detail === undefined ? '' : ` - ${JSON.stringify(detail)}`
  console.error(`  FAIL  ${label}${extra}`)
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

const TODAY = todayKey()
const REQUESTER_DATE = process.env.REQUESTER_WORK_DATE || addDays(TODAY, 21)
const COUNTERPARTY_DATE = process.env.COUNTERPARTY_WORK_DATE || addDays(TODAY, 22)

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

async function api(token, pathname, { method = 'GET', body } = {}) {
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

async function mintToken(userId, { roles = 'admin', perms }) {
  const res = await api('', `/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`)
  const token = res.body?.token || ''
  if (!token) {
    throw new Error(`could not mint dev-token for ${userId} (status ${res.status}); provide explicit tokens for this staging environment`)
  }
  return token
}

function assertSyntheticSmokeUser(userId, label) {
  if (String(userId).startsWith('shiftswap-sw5-')) return
  throw new Error(`refusing to run: ${label} "${userId}" is not a synthetic shiftswap-sw5-* user. Use the default synthetic ids or mint fallback tokens for disposable shiftswap-sw5-* subjects.`)
}

async function resolveTokens() {
  assertSyntheticSmokeUser(REQUESTER_USER, 'REQUESTER_USER_ID')
  assertSyntheticSmokeUser(COUNTERPARTY_USER, 'COUNTERPARTY_USER_ID')

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

  if (!requesterToken) {
    requesterToken = await mintToken(REQUESTER_USER, {
      roles: 'user',
      perms: 'attendance:read,attendance:write',
    })
    console.log('  minted requester dev-token')
  } else {
    const subject = jwtSubject(requesterToken)
    if (subject == null) throw new Error('could not decode REQUESTER_TOKEN subject; provide a valid JWT or omit REQUESTER_TOKEN to mint a dev-token')
    if (String(subject) !== REQUESTER_USER) {
      throw new Error(`REQUESTER_TOKEN subject "${subject}" != REQUESTER_USER_ID "${REQUESTER_USER}". Set REQUESTER_USER_ID to the token subject.`)
    }
    console.log(`  using supplied requester token (subject ${subject})`)
  }

  if (!counterpartyToken) {
    counterpartyToken = await mintToken(COUNTERPARTY_USER, {
      roles: 'user',
      perms: 'attendance:read,attendance:write',
    })
    console.log('  minted counterparty dev-token')
  } else {
    const subject = jwtSubject(counterpartyToken)
    if (subject == null) throw new Error('could not decode COUNTERPARTY_TOKEN subject; provide a valid JWT or omit COUNTERPARTY_TOKEN to mint a dev-token')
    if (String(subject) !== COUNTERPARTY_USER) {
      throw new Error(`COUNTERPARTY_TOKEN subject "${subject}" != COUNTERPARTY_USER_ID "${COUNTERPARTY_USER}". Set COUNTERPARTY_USER_ID to the token subject.`)
    }
    console.log(`  using supplied counterparty token (subject ${subject})`)
  }
}

async function preflightDatabase() {
  const row = (await q(
    `SELECT
       to_regclass('public.attendance_shift_swap_requests') IS NOT NULL AS has_swap_details,
       to_regclass('public.attendance_shift_assignments') IS NOT NULL AS has_assignments,
       to_regclass('public.attendance_shifts') IS NOT NULL AS has_shifts,
       to_regclass('public.attendance_requests') IS NOT NULL AS has_requests,
       to_regclass('public.approval_instances') IS NOT NULL AS has_approval_instances,
       to_regclass('public.approval_records') IS NOT NULL AS has_approval_records,
       to_regclass('public.approval_assignments') IS NOT NULL AS has_approval_assignments`,
  ))[0] || {}
  const ready = row.has_swap_details === true
    && row.has_assignments === true
    && row.has_shifts === true
    && row.has_requests === true
    && row.has_approval_instances === true
    && row.has_approval_records === true
    && row.has_approval_assignments === true
  ok(ready, 'DB cleanup/assertion channel reachable and shift-swap tables exist', row)
  if (!ready) throw new Error('staging DB missing shift-swap tables or unreachable through DATABASE_URL')
}

async function preflightSmokeUsersEmpty() {
  const users = [REQUESTER_USER, COUNTERPARTY_USER]
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND user_id = ANY($2::text[])) AS assignments,
       (SELECT count(*)::int FROM attendance_requests WHERE org_id = $1 AND user_id = ANY($2::text[])) AS requests,
       (SELECT count(*)::int FROM attendance_shift_swap_requests WHERE org_id = $1 AND (requester_user_id = ANY($2::text[]) OR counterparty_user_id = ANY($2::text[]))) AS swap_details,
       (SELECT count(*)::int FROM attendance_events WHERE org_id = $1 AND user_id = ANY($2::text[])) AS events,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND user_id = ANY($2::text[])) AS records`,
    [ORG_ID, users],
  ))[0] || {}
  const clean = Object.values(row).every(value => Number(value) === 0)
  ok(clean, 'synthetic requester/counterparty have no pre-existing attendance residue', row)
  if (!clean) {
    throw new Error(`refusing to run against reused synthetic users; clean or choose fresh shiftswap-sw5-* subjects first: ${JSON.stringify(row)}`)
  }
}

async function verifyApiDbCoherence() {
  const probeName = `${STAMP}-db-coherence-probe`
  const res = await api(adminToken, '/api/attendance/shifts', {
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
    if (visible?.id !== id) {
      throw new Error('DATABASE_URL does not appear to point at the same DB used by BASE_URL')
    }
  } finally {
    const del = await api(adminToken, `/api/attendance/shifts/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(error => ({ status: 0, body: { error: String(error?.message || error) } }))
    ok(del.status === 200 || del.status === 404, `API/DB coherence probe deleted via API (status ${del.status})`, del.body)
    if (del.status !== 200 && del.status !== 404) {
      throw new Error('API/DB coherence probe cleanup failed; inspect the stamped probe shift before re-running')
    }
  }
}

async function saveSettings(update) {
  const res = await api(adminToken, '/api/attendance/settings', { method: 'PUT', body: update })
  ok(res.status === 200, `save settings ${Object.keys(update).join(',')} (status ${res.status})`, res.body)
  if (res.status !== 200) throw new Error('settings update failed')
  return res.body?.data || {}
}

async function createShift(nameSuffix, start, end) {
  const res = await api(adminToken, '/api/attendance/shifts', {
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
  createdShiftIds.push(id)
  return id
}

async function createAssignment(userId, shiftId, date, label) {
  const res = await api(adminToken, '/api/attendance/assignments', {
    method: 'POST',
    body: {
      userId,
      shiftId,
      startDate: date,
      endDate: date,
      isActive: true,
      slotIndex: 0,
    },
  })
  const assignment = res.body?.data?.assignment || res.body?.data
  ok(res.status === 201 && assignment?.id && (assignment.publishStatus ?? assignment.publish_status) === 'published',
    `create published source assignment ${label} (status ${res.status})`, res.body)
  if (!assignment?.id) throw new Error(`assignment ${label} was not created`)
  createdAssignmentIds.push(assignment.id)
  return assignment.id
}

async function createApprovalFlow() {
  const res = await api(adminToken, '/api/attendance/approval-flows', {
    method: 'POST',
    body: {
      name: `${STAMP}-shift-swap-flow`,
      requestType: 'shift_swap',
      isActive: true,
      steps: [],
    },
  })
  const id = res.body?.data?.id || res.body?.data?.flow?.id
  ok((res.status === 200 || res.status === 201) && !!id, `create shift_swap approval flow (status ${res.status})`, res.body)
  if (!id) throw new Error('shift_swap approval flow was not created')
  createdFlowIds.push(id)
  return id
}

async function effectiveItem(userId, date) {
  const res = await api(adminToken, `/api/attendance/effective-calendar?from=${date}&to=${date}&userId=${encodeURIComponent(userId)}`)
  ok(res.status === 200, `effective-calendar ${userId} ${date} returns 200 (got ${res.status})`, res.body)
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

function effectiveShowsShift(item, expectedShiftId) {
  const actualShiftId = effectiveShiftId(item)
  if (actualShiftId) return actualShiftId === expectedShiftId
  return item?.effective?.source === 'shift'
}

async function createSwapRequest(requesterAssignmentId, counterpartyAssignmentId, approvalFlowId) {
  const res = await api(requesterToken, '/api/attendance/shift-swap-requests', {
    method: 'POST',
    body: {
      requesterAssignmentId,
      counterpartyAssignmentId,
      approvalFlowId,
      reason: `${STAMP} staging smoke`,
    },
  })
  const requestId = res.body?.data?.request?.id
  ok(res.status === 201 && !!requestId, `create shift-swap request (status ${res.status})`, res.body)
  if (!requestId) throw new Error('shift-swap request was not created')
  createdRequestIds.push(requestId)
  const requestRow = (await q(
    `SELECT approval_instance_id FROM attendance_requests WHERE org_id = $1 AND id = $2`,
    [ORG_ID, requestId],
  ))[0]
  if (requestRow?.approval_instance_id) createdApprovalInstanceIds.push(String(requestRow.approval_instance_id))
  return requestId
}

async function main() {
  console.log(`SW5 shift-swap staging smoke @ ${BASE_URL} (org ${ORG_ID}, stamp ${STAMP})`)
  await preflightDatabase()
  await resolveTokens()

  const settingsRes = await api(adminToken, '/api/attendance/settings')
  ok(settingsRes.status === 200, `auth: GET settings 200 (got ${settingsRes.status})`, settingsRes.body)
  if (settingsRes.status !== 200) throw new Error('cannot authenticate to staging')
  originalSettings = settingsRes.body?.data || {}
  await preflightSmokeUsersEmpty()
  await verifyApiDbCoherence()
  cleanupAllowed = true

  await saveSettings({
    shiftEditPolicy: { mode: 'unrestricted', windowDays: 0 },
    shiftCompliance: { enforcement: 'warn', dailyMaxMinutes: null, weeklyMaxMinutes: null, monthlyMaxMinutes: null },
    multiShiftDay: { enabled: false, maxSlots: 1 },
  })

  const shiftA = await createShift('requester-source', '09:00', '13:00')
  const shiftB = await createShift('counterparty-source', '14:00', '18:00')
  const requesterAssignmentId = await createAssignment(REQUESTER_USER, shiftA, REQUESTER_DATE, 'requester')
  const counterpartyAssignmentId = await createAssignment(COUNTERPARTY_USER, shiftB, COUNTERPARTY_DATE, 'counterparty')

  const beforeRequester = await effectiveItem(REQUESTER_USER, REQUESTER_DATE)
  const beforeCounterparty = await effectiveItem(COUNTERPARTY_USER, COUNTERPARTY_DATE)
  ok(effectiveShowsShift(beforeRequester, shiftA), 'pre-swap requester effective-calendar sees a shift source', {
    expectedShiftId: shiftA,
    actualShiftId: effectiveShiftId(beforeRequester),
    effective: beforeRequester?.effective,
  })
  ok(effectiveShowsShift(beforeCounterparty, shiftB), 'pre-swap counterparty effective-calendar sees a shift source', {
    expectedShiftId: shiftB,
    actualShiftId: effectiveShiftId(beforeCounterparty),
    effective: beforeCounterparty?.effective,
  })

  const eventRowsBefore = await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_events WHERE org_id = $1 AND user_id = ANY($2::text[])) AS events,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND user_id = ANY($2::text[])) AS records`,
    [ORG_ID, [REQUESTER_USER, COUNTERPARTY_USER]],
  )
  const eventCountsBefore = eventRowsBefore[0] || { events: 0, records: 0 }

  const flowId = await createApprovalFlow()
  const requestId = await createSwapRequest(requesterAssignmentId, counterpartyAssignmentId, flowId)

  const listAsRequester = await api(requesterToken, '/api/attendance/shift-swap-requests')
  const listed = listAsRequester.body?.data?.items || []
  ok(listAsRequester.status === 200 && listed.some(item => item.requestId === requestId || item.request_id === requestId),
    'requester list sees the pending shift-swap request', listAsRequester.body)

  const accept = await api(counterpartyToken, `/api/attendance/shift-swap-requests/${requestId}/accept`, {
    method: 'POST',
    body: {},
  })
  ok(accept.status === 200 && (accept.body?.data?.shiftSwap?.counterpartyStatus ?? accept.body?.data?.shiftSwap?.counterparty_status) === 'accepted',
    `counterparty accepts (status ${accept.status})`, accept.body)

  const approve = await api(adminToken, `/api/attendance/requests/${requestId}/approve`, {
    method: 'POST',
    body: { comment: `${STAMP} final approve` },
  })
  ok(approve.status === 200 && (approve.body?.data?.status === 'approved' || approve.body?.data?.request?.status === 'approved'),
    `admin final approval succeeds (status ${approve.status})`, approve.body)

  const detail = (await q(
    `SELECT r.status AS request_status, d.counterparty_status,
            d.requester_replacement_assignment_id,
            d.counterparty_replacement_assignment_id,
            d.finalized_at
       FROM attendance_requests r
       JOIN attendance_shift_swap_requests d ON d.request_id = r.id
      WHERE r.org_id = $1 AND r.id = $2`,
    [ORG_ID, requestId],
  ))[0]
  ok(detail?.request_status === 'approved'
    && detail?.counterparty_status === 'accepted'
    && !!detail?.requester_replacement_assignment_id
    && !!detail?.counterparty_replacement_assignment_id
    && !!detail?.finalized_at,
    'detail row finalized with both replacement ids', detail)

  const replacementIds = [
    detail?.requester_replacement_assignment_id,
    detail?.counterparty_replacement_assignment_id,
  ].filter(Boolean)
  createdAssignmentIds.push(...replacementIds)

  const sourceRows = await q(
    `SELECT id, is_active
       FROM attendance_shift_assignments
      WHERE org_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id`,
    [ORG_ID, [requesterAssignmentId, counterpartyAssignmentId]],
  )
  ok(sourceRows.length === 2 && sourceRows.every(row => row.is_active === false),
    'source assignments are soft-deactivated after approval', sourceRows)

  const replacements = await q(
    `SELECT id, user_id, shift_id, slot_index, start_date, end_date, is_active,
            publish_status, producer_type, producer_ref_id, producer_key, producer_run_id
       FROM attendance_shift_assignments
      WHERE org_id = $1 AND id = ANY($2::uuid[])
      ORDER BY user_id`,
    [ORG_ID, replacementIds],
  )
  const requesterReplacement = replacements.find(row => row.user_id === REQUESTER_USER)
  const counterpartyReplacement = replacements.find(row => row.user_id === COUNTERPARTY_USER)
  ok(replacements.length === 2, 'exactly two replacement assignments exist', replacements)
  ok(requesterReplacement
    && requesterReplacement.shift_id === shiftB
    && dateOnly(requesterReplacement.start_date) === COUNTERPARTY_DATE
    && dateOnly(requesterReplacement.end_date) === COUNTERPARTY_DATE
    && requesterReplacement.is_active === true
    && requesterReplacement.publish_status === 'published'
    && requesterReplacement.producer_type === 'shift_swap'
    && requesterReplacement.producer_ref_id === requestId
    && requesterReplacement.producer_run_id === requestId
    && requesterReplacement.producer_key === `shift_swap:${requestId}:${REQUESTER_USER}:${COUNTERPARTY_DATE}:0`,
    'requester replacement has counterparty shift/date and deterministic provenance', requesterReplacement)
  ok(counterpartyReplacement
    && counterpartyReplacement.shift_id === shiftA
    && dateOnly(counterpartyReplacement.start_date) === REQUESTER_DATE
    && dateOnly(counterpartyReplacement.end_date) === REQUESTER_DATE
    && counterpartyReplacement.is_active === true
    && counterpartyReplacement.publish_status === 'published'
    && counterpartyReplacement.producer_type === 'shift_swap'
    && counterpartyReplacement.producer_ref_id === requestId
    && counterpartyReplacement.producer_run_id === requestId
    && counterpartyReplacement.producer_key === `shift_swap:${requestId}:${COUNTERPARTY_USER}:${REQUESTER_DATE}:0`,
    'counterparty replacement has requester shift/date and deterministic provenance', counterpartyReplacement)

  const requesterAfter = await effectiveItem(REQUESTER_USER, COUNTERPARTY_DATE)
  const counterpartyAfter = await effectiveItem(COUNTERPARTY_USER, REQUESTER_DATE)
  ok(effectiveShowsShift(requesterAfter, shiftB),
    'post-swap requester effective-calendar sees a shift source on counterparty date', {
      expectedShiftId: shiftB,
      actualShiftId: effectiveShiftId(requesterAfter),
      effective: requesterAfter?.effective,
    })
  ok(effectiveShowsShift(counterpartyAfter, shiftA),
    'post-swap counterparty effective-calendar sees a shift source on requester date', {
      expectedShiftId: shiftA,
      actualShiftId: effectiveShiftId(counterpartyAfter),
      effective: counterpartyAfter?.effective,
    })

  const eventRowsAfter = await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_events WHERE org_id = $1 AND user_id = ANY($2::text[])) AS events,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND user_id = ANY($2::text[])) AS records`,
    [ORG_ID, [REQUESTER_USER, COUNTERPARTY_USER]],
  )
  const eventCountsAfter = eventRowsAfter[0] || { events: 0, records: 0 }
  ok(Number(eventCountsAfter.events) === Number(eventCountsBefore.events)
    && Number(eventCountsAfter.records) === Number(eventCountsBefore.records),
    'attendance_events and attendance_records are unchanged by the swap finalizer',
    { before: eventCountsBefore, after: eventCountsAfter })
}

async function cleanup() {
  console.log('\n--- restore + cleanup ---')
  if (!cleanupAllowed) {
    console.log('  cleanup SKIPPED - safety gate not satisfied; no API mutations should have happened.')
    return
  }

  try {
    if (originalSettings) {
      const restoreRes = await api(adminToken, '/api/attendance/settings', { method: 'PUT', body: originalSettings })
      ok(restoreRes.status === 200, `restore original settings (status ${restoreRes.status})`, restoreRes.body)
    }
  } catch (error) {
    failures.push(`settings restore failed: ${error?.message || error}`)
    console.error(`  FAIL  settings restore failed - ${error?.message || error}`)
  }

  const users = [REQUESTER_USER, COUNTERPARTY_USER]
  const requestBusinessKeys = createdRequestIds.map(id => `attendance-request:${id}`)
  const approvalInstanceIdsForCleanup = new Set(createdApprovalInstanceIds)
  async function cleanupStep(label, text, params) {
    try {
      await q(text, params)
    } catch (error) {
      failures.push(`cleanup ${label} failed: ${error?.message || error}`)
      console.error(`  FAIL  cleanup ${label} failed - ${error?.message || error}`)
    }
  }

  try {
    const approvalRows = await q(
      `SELECT id
         FROM approval_instances
        WHERE id = ANY($1::text[])
           OR business_key = ANY($2::text[])`,
      [createdApprovalInstanceIds, requestBusinessKeys],
    )
    for (const row of approvalRows) {
      if (row?.id) approvalInstanceIdsForCleanup.add(String(row.id))
    }
  } catch (error) {
    failures.push(`approval instance lookup failed: ${error?.message || error}`)
    console.error(`  FAIL  approval instance lookup failed - ${error?.message || error}`)
  }
  const approvalInstanceIds = Array.from(approvalInstanceIdsForCleanup)

  await cleanupStep(
    'approval records',
    'DELETE FROM approval_records WHERE instance_id = ANY($1::text[])',
    [approvalInstanceIds],
  )
  await cleanupStep(
    'approval assignments',
    'DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])',
    [approvalInstanceIds],
  )
  await cleanupStep(
    'approval instances',
    `DELETE FROM approval_instances
      WHERE id = ANY($1::text[])
         OR business_key = ANY($2::text[])`,
    [approvalInstanceIds, requestBusinessKeys],
  )
  await cleanupStep(
    'attendance requests',
    `DELETE FROM attendance_requests
      WHERE org_id = $1
        AND id = ANY($2::uuid[])`,
    [ORG_ID, createdRequestIds],
  )
  await cleanupStep(
    'assignments',
    `DELETE FROM attendance_shift_assignments
      WHERE org_id = $1
        AND (
          id = ANY($2::uuid[])
          OR shift_id = ANY($3::uuid[])
          OR producer_ref_id = ANY($4::uuid[])
        )`,
    [ORG_ID, createdAssignmentIds, createdShiftIds, createdRequestIds],
  )
  await cleanupStep(
    'shifts',
    'DELETE FROM attendance_shifts WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR name LIKE $3)',
    [ORG_ID, createdShiftIds, `${STAMP}%`],
  )
  await cleanupStep(
    'approval flows',
    'DELETE FROM attendance_approval_flows WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR name LIKE $3)',
    [ORG_ID, createdFlowIds, `${STAMP}%`],
  )

  const residue = (await q(
    `SELECT
       (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id = $1 AND (user_id = ANY($2::text[]) OR shift_id = ANY($3::uuid[]) OR producer_ref_id = ANY($4::uuid[]))) AS assignments,
       (SELECT count(*)::int FROM attendance_shifts WHERE org_id = $1 AND (id = ANY($3::uuid[]) OR name LIKE $5)) AS shifts,
       (SELECT count(*)::int FROM attendance_requests WHERE org_id = $1 AND (id = ANY($4::uuid[]) OR user_id = ANY($2::text[]))) AS requests,
       (SELECT count(*)::int FROM attendance_shift_swap_requests WHERE org_id = $1 AND (request_id = ANY($4::uuid[]) OR requester_user_id = ANY($2::text[]) OR counterparty_user_id = ANY($2::text[]))) AS swap_details,
       (SELECT count(*)::int FROM attendance_approval_flows WHERE org_id = $1 AND (id = ANY($6::uuid[]) OR name LIKE $5)) AS flows,
       (SELECT count(*)::int FROM approval_instances WHERE id = ANY($7::text[]) OR business_key = ANY($8::text[])) AS approval_instances,
       (SELECT count(*)::int FROM approval_records WHERE instance_id = ANY($7::text[])) AS approval_records,
       (SELECT count(*)::int FROM approval_assignments WHERE instance_id = ANY($7::text[])) AS approval_assignments,
       (SELECT count(*)::int FROM attendance_events WHERE org_id = $1 AND user_id = ANY($2::text[])) AS events,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1 AND user_id = ANY($2::text[])) AS records`,
    [ORG_ID, users, createdShiftIds, createdRequestIds, `${STAMP}%`, createdFlowIds, approvalInstanceIds, requestBusinessKeys],
  ).catch(error => {
    failures.push(`residue check failed: ${error?.message || error}`)
    return [{ assignments: -1, shifts: -1, requests: -1, swap_details: -1, flows: -1, approval_instances: -1, approval_records: -1, approval_assignments: -1, events: -1, records: -1 }]
  }))[0] || {}
  const clean = Object.values(residue).every(value => Number(value) === 0)
  ok(clean,
    `cleanup residue = 0 (assignments ${residue.assignments}, shifts ${residue.shifts}, requests ${residue.requests}, swap_details ${residue.swap_details}, flows ${residue.flows}, approval_instances ${residue.approval_instances}, approval_records ${residue.approval_records}, approval_assignments ${residue.approval_assignments}, events ${residue.events}, records ${residue.records})`,
    residue)
}

main()
  .catch(error => {
    failures.push(`ABORTED: ${error?.message || error}`)
    console.error(`\nABORTED: ${error?.stack || error?.message || error}`)
  })
  .finally(async () => {
    await cleanup().catch(error => {
      failures.push(`cleanup error: ${error?.message || error}`)
      console.error(`cleanup error: ${error?.stack || error?.message || error}`)
    })
    await pool.end().catch(() => undefined)
    const failed = failures.length
    console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${failed} failed${failed ? ` (${failures.join('; ')})` : ''} ===  stamp ${STAMP}`)
    if (failed === 0) {
      console.log(`SHIFT_SWAP_SW5_STAGING_SMOKE_PASS deploy=${DEPLOY_SHA} stamp=${STAMP} requesterDate=${REQUESTER_DATE} counterpartyDate=${COUNTERPARTY_DATE} residue=0`)
    }
    process.exit(failed === 0 ? 0 : 1)
  })
