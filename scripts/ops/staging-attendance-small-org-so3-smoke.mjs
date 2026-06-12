#!/usr/bin/env node
// SO3 staging smoke — 小组织挂部门 / small scheduling organizations.
//
// Validates the SO0→SO2 chain against staging through the same API surface that the
// admin cockpit uses: schedule-group CRUD, members, scheduler scopes, and scoped
// actor access. SQL is used only for precise cleanup and residue checks.
//
// Usage:
//   BASE_URL=http://127.0.0.1:8082 \
//   DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
//   node scripts/ops/staging-attendance-small-org-so3-smoke.mjs
//
// If staging disables /api/auth/dev-token, provide:
//   ADMIN_TOKEN=<admin bearer> SCOPED_TOKEN=<non-admin scoped bearer> SCOPED_USER_ID=<scoped token subject>

import { randomUUID } from 'node:crypto'

const BASE_URL = (process.env.BASE_URL || process.env.BASE || '').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const ORG_ID = process.env.ORG_ID || 'default'

if (!BASE_URL || !DATABASE_URL) {
  console.error('FAIL: BASE_URL and DATABASE_URL are required.')
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet node scripts/ops/staging-attendance-small-org-so3-smoke.mjs')
  process.exit(2)
}

const { default: pg } = await import('pg')

const SUFFIX = Date.now().toString(36)
const STAMP = `smallorg-so3-${SUFFIX}`
const ADMIN_USER = process.env.ADMIN_USER_ID || `${STAMP}-admin`
const SCOPED_USER = process.env.SCOPED_USER_ID || `${STAMP}-scoped`
const LEAD_USER = `${STAMP}-lead`
const DISPATCH_USER = `${STAMP}-dispatch`
const OTHER_USER = `${STAMP}-other`
const CHILD_DEPT = `${STAMP}-dept-child`
const SIBLING_DEPT = `${STAMP}-dept-sibling`

let adminToken = process.env.ADMIN_TOKEN || process.env.SMOKE_TOKEN || process.env.TOKEN || ''
let scopedToken = process.env.SCOPED_TOKEN || ''
let pass = 0
const failures = []
const createdGroupIds = []
const createdScopeIds = []
const pool = new pg.Pool({ connectionString: DATABASE_URL })

function ok(condition, label, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failures.push(label)
  const extra = detail === undefined ? '' : ` — ${JSON.stringify(detail)}`
  console.error(`  FAIL  ${label}${extra}`)
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

async function mintToken(userId, { admin = false } = {}) {
  const roles = admin ? 'admin' : 'user'
  const perms = admin ? 'attendance:read,attendance:write,attendance:admin' : 'attendance:read,attendance:write'
  const res = await api('', `/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${roles}&perms=${encodeURIComponent(perms)}`)
  const token = res.body?.token || ''
  if (!token) {
    throw new Error(`could not mint ${admin ? 'admin' : 'scoped'} dev-token for ${userId} (status ${res.status}); provide ADMIN_TOKEN and SCOPED_TOKEN/SCOPED_USER_ID`)
  }
  return token
}

function expectRouteError(response, status, code, label) {
  const actualCode = response.body?.error?.code
  ok(response.status === status && actualCode === code, label, { status: response.status, code: actualCode, body: response.body })
}

async function q(text, params) {
  return pool.query(text, params).then(result => result.rows)
}

async function createScheduleGroup({ name, code, parentId = null, departmentRef = null }) {
  const res = await api(adminToken, '/api/attendance/schedule-groups', {
    method: 'POST',
    body: {
      name,
      code,
      description: STAMP,
      parentId,
      departmentRef,
    },
  })
  const id = res.body?.data?.id
  ok((res.status === 200 || res.status === 201) && !!id, `create schedule group ${code}`, { status: res.status, body: res.body })
  if (!id) throw new Error(`schedule group ${code} not created`)
  createdGroupIds.push(id)
  return res.body.data
}

async function createSchedulerScope(body, label) {
  const res = await api(adminToken, '/api/attendance/scheduler-scopes', {
    method: 'POST',
    body,
  })
  const id = res.body?.data?.id
  ok(res.status === 200 && !!id, label, { status: res.status, body: res.body })
  if (!id) throw new Error(`scheduler scope not created: ${label}`)
  createdScopeIds.push(id)
  return id
}

async function cleanup() {
  console.log('\n--- cleanup ---')
  try {
    await q(
      `DELETE FROM attendance_schedule_group_members
       WHERE org_id = $1
         AND (
           schedule_group_id = ANY($2::uuid[])
           OR user_id = ANY($3::text[])
         )`,
      [ORG_ID, createdGroupIds, [LEAD_USER, DISPATCH_USER, OTHER_USER]],
    ).catch(() => undefined)
    await q(
      `DELETE FROM attendance_scheduler_scopes
       WHERE org_id = $1
         AND id = ANY($2::uuid[])`,
      [ORG_ID, createdScopeIds],
    ).catch(() => undefined)
    await q(
      `DELETE FROM attendance_schedule_groups
       WHERE org_id = $1
         AND (id = ANY($2::uuid[]) OR code LIKE $3)`,
      [ORG_ID, createdGroupIds, `${STAMP}%`],
    ).catch(() => undefined)

    const residue = (await q(
      `SELECT
         (SELECT COUNT(*)::int FROM attendance_schedule_groups WHERE org_id = $1 AND code LIKE $2) AS groups,
         (SELECT COUNT(*)::int FROM attendance_schedule_group_members WHERE org_id = $1 AND user_id = ANY($3::text[])) AS members,
         (SELECT COUNT(*)::int FROM attendance_scheduler_scopes WHERE org_id = $1 AND id = ANY($4::uuid[])) AS scopes`,
      [ORG_ID, `${STAMP}%`, [LEAD_USER, DISPATCH_USER, OTHER_USER], createdScopeIds],
    ))[0] ?? { groups: 0, members: 0, scopes: 0 }
    const residueOk = Number(residue.groups) === 0 && Number(residue.members) === 0 && Number(residue.scopes) === 0
    ok(residueOk, `cleanup residue = 0 (groups ${residue.groups}, members ${residue.members}, scopes ${residue.scopes})`, residue)
  } finally {
    await pool.end().catch(() => undefined)
  }
}

async function resolveTokens() {
  if (!/^smallorg-so3-/.test(SCOPED_USER)) {
    throw new Error(`refusing to run: SCOPED_USER_ID "${SCOPED_USER}" is not synthetic. Use a disposable smallorg-so3-* subject.`)
  }

  if (!adminToken) {
    adminToken = await mintToken(ADMIN_USER, { admin: true })
    console.log('  minted admin dev-token')
  }
  if (!scopedToken) {
    scopedToken = await mintToken(SCOPED_USER, { admin: false })
    console.log('  minted scoped dev-token')
  } else {
    const subject = jwtSubject(scopedToken)
    if (subject == null) throw new Error('could not decode SCOPED_TOKEN subject; provide a valid JWT or omit SCOPED_TOKEN to mint a dev-token')
    if (String(subject) !== SCOPED_USER) {
      throw new Error(`SCOPED_TOKEN subject "${subject}" != SCOPED_USER_ID "${SCOPED_USER}". Set SCOPED_USER_ID to the token subject.`)
    }
    console.log(`  using supplied scoped token (subject ${subject})`)
  }
}

async function preflightDatabase() {
  const rows = await q(
    `SELECT
       to_regclass('public.attendance_schedule_groups') IS NOT NULL AS has_groups,
       to_regclass('public.attendance_schedule_group_members') IS NOT NULL AS has_members,
       to_regclass('public.attendance_scheduler_scopes') IS NOT NULL AS has_scopes`,
    [],
  )
  const row = rows[0] ?? {}
  ok(row.has_groups === true && row.has_members === true && row.has_scopes === true,
    'DB cleanup/assertion channel reachable and SO tables exist', row)
  if (!(row.has_groups === true && row.has_members === true && row.has_scopes === true)) {
    throw new Error('staging DB missing small-org tables or unreachable through DATABASE_URL')
  }
}

async function main() {
  console.log(`SO3 small-org staging smoke @ ${BASE_URL} (org ${ORG_ID}, stamp ${STAMP})`)
  await preflightDatabase()
  await resolveTokens()

  const auth = await api(adminToken, '/api/attendance/schedule-groups?pageSize=1')
  ok(auth.status === 200, `admin auth/list reachable (${auth.status})`, auth.body)
  if (auth.status !== 200) throw new Error('admin token cannot read attendance schedule groups')

  const root = await createScheduleGroup({
    name: `SO3 Root ${SUFFIX}`,
    code: `${STAMP}-root`,
    departmentRef: `${STAMP}-dept-root`,
  })
  const child = await createScheduleGroup({
    name: `SO3 Child ${SUFFIX}`,
    code: `${STAMP}-child`,
    parentId: root.id,
    departmentRef: CHILD_DEPT,
  })
  const sibling = await createScheduleGroup({
    name: `SO3 Sibling ${SUFFIX}`,
    code: `${STAMP}-sibling`,
    parentId: root.id,
    departmentRef: SIBLING_DEPT,
  })

  const adminList = await api(adminToken, `/api/attendance/schedule-groups?includeInactive=true&pageSize=200`)
  const adminItems = adminList.body?.data?.items ?? []
  const adminChild = adminItems.find(item => item.id === child.id)
  ok(adminList.status === 200 && adminItems.some(item => item.id === root.id) && adminChild?.parentId === root.id && adminChild?.departmentRef === CHILD_DEPT,
    'admin workbench API sees parent/child/dept tree', { status: adminList.status, child: adminChild })

  const leadAdd = await api(adminToken, `/api/attendance/schedule-groups/${child.id}/members`, {
    method: 'POST',
    body: { userIds: [LEAD_USER], role: 'lead', source: 'manual' },
  })
  ok(leadAdd.status === 200 && leadAdd.body?.data?.items?.[0]?.userId === LEAD_USER, 'admin adds lead member to child group', leadAdd.body)

  await createSchedulerScope({
    subjectType: 'user',
    subjectRef: SCOPED_USER,
    actions: ['view', 'edit'],
    scope: { departments: [CHILD_DEPT] },
  }, 'create view/edit department scope for scoped actor')
  await createSchedulerScope({
    subjectType: 'user',
    subjectRef: SCOPED_USER,
    actions: ['dispatch'],
    scope: { scheduleGroupIds: [child.id], userIds: [DISPATCH_USER] },
  }, 'create dispatch scope for one child group/user')

  const scopedCreate = await api(scopedToken, '/api/attendance/schedule-groups', {
    method: 'POST',
    body: { name: `SO3 forbidden ${SUFFIX}`, code: `${STAMP}-forbidden` },
  })
  expectRouteError(scopedCreate, 403, 'FORBIDDEN', 'scoped actor has no central attendance:admin create permission')

  const scopedList = await api(scopedToken, '/api/attendance/schedule-groups?includeInactive=true&pageSize=200')
  const scopedIds = (scopedList.body?.data?.items ?? []).map(item => item.id)
  ok(scopedList.status === 200 && scopedIds.includes(child.id) && !scopedIds.includes(root.id) && !scopedIds.includes(sibling.id),
    'scoped list contains only department-matching child group', { status: scopedList.status, scopedIds })

  const scopedChild = await api(scopedToken, `/api/attendance/schedule-groups/${child.id}`)
  ok(scopedChild.status === 200 && scopedChild.body?.data?.departmentRef === CHILD_DEPT, 'scoped actor can read child detail', scopedChild.body)
  const scopedSibling = await api(scopedToken, `/api/attendance/schedule-groups/${sibling.id}`)
  expectRouteError(scopedSibling, 403, 'SCHEDULER_SCOPE_FORBIDDEN', 'scoped actor cannot read sibling detail')

  const membersView = await api(scopedToken, `/api/attendance/schedule-groups/${child.id}/members?pageSize=200`)
  const memberItems = membersView.body?.data?.items ?? []
  ok(membersView.status === 200 && memberItems.some(item => item.userId === LEAD_USER && item.role === 'lead'),
    'scoped actor can view child members', { status: membersView.status, memberItems })

  const edit = await api(scopedToken, `/api/attendance/schedule-groups/${child.id}`, {
    method: 'PUT',
    body: { description: `${STAMP} scoped edit` },
  })
  ok(edit.status === 200 && edit.body?.data?.description === `${STAMP} scoped edit`, 'scoped actor can edit child description', edit.body)

  const moveOut = await api(scopedToken, `/api/attendance/schedule-groups/${child.id}`, {
    method: 'PUT',
    body: { departmentRef: SIBLING_DEPT },
  })
  expectRouteError(moveOut, 403, 'SCHEDULER_SCOPE_FORBIDDEN', 'scoped actor cannot move child out of its department scope')
  const childRow = (await q('SELECT department_ref, description FROM attendance_schedule_groups WHERE id = $1 AND org_id = $2', [child.id, ORG_ID]))[0]
  ok(childRow?.department_ref === CHILD_DEPT && childRow?.description === `${STAMP} scoped edit`,
    'failed scope move leaves child department unchanged', childRow)

  const addMember = await api(scopedToken, `/api/attendance/schedule-groups/${child.id}/members`, {
    method: 'POST',
    body: { userIds: [DISPATCH_USER], role: 'member', source: 'manual' },
  })
  const dispatchMemberId = addMember.body?.data?.items?.[0]?.id
  ok(addMember.status === 200 && !!dispatchMemberId, 'scoped actor can dispatch allowed user into child group', addMember.body)

  const wrongUserAdd = await api(scopedToken, `/api/attendance/schedule-groups/${child.id}/members`, {
    method: 'POST',
    body: { userIds: [OTHER_USER], role: 'member', source: 'manual' },
  })
  expectRouteError(wrongUserAdd, 403, 'SCHEDULER_SCOPE_FORBIDDEN', 'dispatch scope blocks unlisted user')

  const wrongGroupAdd = await api(scopedToken, `/api/attendance/schedule-groups/${sibling.id}/members`, {
    method: 'POST',
    body: { userIds: [DISPATCH_USER], role: 'member', source: 'manual' },
  })
  expectRouteError(wrongGroupAdd, 403, 'SCHEDULER_SCOPE_FORBIDDEN', 'dispatch scope blocks sibling group')

  if (dispatchMemberId) {
    const deleteMember = await api(scopedToken, `/api/attendance/schedule-groups/${child.id}/members/${dispatchMemberId}`, {
      method: 'DELETE',
    })
    ok(deleteMember.status === 200 && deleteMember.body?.data?.id === dispatchMemberId,
      'scoped actor can remove allowed dispatched member', deleteMember.body)
  }

  const siblingMemberId = randomUUID()
  await q(
    `INSERT INTO attendance_schedule_group_members (id, org_id, schedule_group_id, user_id, role, source)
     VALUES ($1, $2, $3, $4, 'member', 'manual')`,
    [siblingMemberId, ORG_ID, sibling.id, DISPATCH_USER],
  )
  const deleteSiblingMember = await api(scopedToken, `/api/attendance/schedule-groups/${sibling.id}/members/${siblingMemberId}`, {
    method: 'DELETE',
  })
  expectRouteError(deleteSiblingMember, 403, 'SCHEDULER_SCOPE_FORBIDDEN', 'dispatch scope blocks deleting sibling member')
  const siblingMemberRows = await q('SELECT id FROM attendance_schedule_group_members WHERE id = $1', [siblingMemberId])
  ok(siblingMemberRows.length === 1, 'blocked sibling member delete leaves row intact')
}

try {
  await main()
} catch (error) {
  failures.push(error?.message || String(error))
  console.error(`\nERROR: ${error?.stack || error}`)
} finally {
  await cleanup()
}

if (failures.length) {
  console.error(`\n=== FAIL — ${pass} passed, ${failures.length} failed ===  stamp ${STAMP}`)
  process.exit(1)
}

console.log(`\n=== PASS — ${pass} passed, 0 failed ===  SMALL_ORG_SO3_STAGING_SMOKE_PASS deploy=<sha> stamp=${STAMP} residue=0`)
