#!/usr/bin/env node
// Tasks staging smoke helper: the non-admin RBAC gate, the P0-A create/list/complete/reopen/read
// surface and the M3 subtask/membership/completion-mode/comment/delete surface of /api/tasks,
// plus row-level isolation for an admitted user with no relation to the smoke's tasks.
//
// Rules:
//   * Every check goes through the real HTTP API. SQL is used only to seed the synthetic
//     identities, for the residue checks and for cleanup.
//   * Identities are derived from STAMP (regex-locked to tasks-smoke-*), all in org ORG_ID
//     (default `default`, the org every other window smoke uses):
//       subject  <stamp>           own role <stamp>-role (tasks:read, tasks:write); admitted to
//                                  the tasks namespace only after the 403 check below.
//       member   <stamp>-member    users + active user_orgs + user_roles on the subject's role +
//                                  admission. Target of the assignee and follower routes, which
//                                  validate the member id shape only (isValidMemberId), not that
//                                  the user exists. Authenticates once, with MEMBER_TOKEN, to
//                                  leave a task it follows: POST /api/tasks/:id/leave needs
//                                  tasks:write and the follower-only `leave` ability.
//       outsider <stamp>-outsider  own role <stamp>-outsider-role (tasks:read) + admission; no
//                                  relation to any smoke task.
//     Role ids pass assertNotAdminRoleId (namespace-admission.ts treats a role id ending
//     "_admin" as delegated admin control).
//   * The task org (req.authenticatedTenantId, the only org the /api/tasks routes read) is set
//     only by a JWT `tenantId` claim that matches an active user_orgs row
//     (AuthService.resolveSessionTenantId). A token without such a claim still authenticates,
//     but its org is null: GET /api/tasks/context answers {orgId: null} and the write routes
//     answer 422 ORG_MISSING. x-org-id never sets the task org. The window runner mints
//     SUBJECT_TOKEN, MEMBER_TOKEN and OUTSIDER_TOKEN with the claim; each token's subject must
//     equal its identity.
//   * rbacGuard('tasks', ...) needs a resolved permission AND a user_namespace_admissions row:
//     role alone is 403.
//   * Row-level visibility: a task the caller has no role on, a soft-deleted task, or a task in
//     another org is 404 NOT_FOUND for reads and writes alike.
//   * Preflight, before any seed row: the P0-A and M3 task tables and the RBAC tables exist; the
//     three M4 tables the task routes read exist (task_list_items, task_list_members,
//     task_user_settings; a missing one fails by name); the catalog carries tasks:read and
//     tasks:write; and no row exists yet for any identity of the stamp.
//   * Cases, in order:
//       gate        subject GET /api/tasks/context is 403 before its admission row exists, 200
//                   with orgId = ORG_ID after.
//       P0-A        create, view=created list, complete -> {done:true}, reopen {scope:'self'}
//                   -> {ok:true}, read.
//       candidates  GET /api/tasks/:child/parent-candidates (before set-parent) is exactly
//                   [{id: parent, title}]: the candidates are the org's live tasks other than
//                   the task and its descendants that the caller can edit, and the subject is a
//                   fresh identity that can edit only the smoke's two tasks. After set-parent the
//                   parent's own candidates are empty (itself and its child are left out).
//       subtask     PATCH /api/tasks/:child/parent {parentId} -> {id, parentId, depth:1}; the
//                   child reads back parentId/depth, the parent lists it under children;
//                   {parentId:null} clears it (depth 0); the parent is set again for the delete
//                   case.
//       assignee    POST /api/tasks/:id/assignees {userId: member} then DELETE
//                   /api/tasks/:id/assignees/:member, each read back.
//       follower    POST /api/tasks/:id/followers {userId: member} then DELETE
//                   /api/tasks/:id/followers/:member, each read back; then the subject adds the
//                   member again and the member leaves with POST /api/tasks/:id/leave (its own
//                   token) -> {id, followers} without the member, read back.
//       mode        PATCH /api/tasks/:id/completion-mode {completionMode:'any'}, then 'all', each
//                   read back.
//       comments    POST, PATCH, DELETE /api/tasks/:id/comments[/:commentId]; after the edit, GET
//                   /api/tasks/:id/comments reads the comment back with the new body; after the
//                   delete, as a tombstone (deleted:true, body:null) that still counts in total.
//       outsider    GET /api/tasks/context is 200 with orgId = ORG_ID (admission and tenant
//                   resolve), then GET /api/tasks/:id is 404 NOT_FOUND. 200 means row-level
//                   visibility failed; 403 means the gate refused it before the row check.
//       delete      DELETE of the parent while its child is live is 409 HAS_CHILDREN; the child
//                   and then the parent delete with 200 {id, deleted:true}; reading either
//                   afterwards is 404 NOT_FOUND.
//   * Every POST /api/tasks answer is checked in the DB before the run uses its id: the id must be
//     a task the subject created, with the title the run sent, in ORG_ID. Any other answer stops
//     the run at that step, and its id is not added to the run's task ids.
//   * Cleanup runs on every path once seeding has started, FK-safe, and hard-deletes only rows of
//     the seeded identities: every task a seeded identity created (soft-deleted included) and the
//     comments (tombstones included), events, followers and assignees under those tasks, then
//     admissions, user_roles (any role, including rows the backend adds on token verification),
//     user_orgs, users, role_permissions, roles. Tasks are selected by created_by, never by an id
//     an API answer carried; the preflight proved the seeded identities had created no task.
//   * Residue is computed after cleanup over every public base table with a task_id column
//     (enumerated from information_schema) and the tasks rows, for the run's task ids (the tasks
//     the seeded identities created, read from the DB), and over every identity table for every
//     seeded user and role. A nonzero count anywhere fails the run, and so does an enumeration
//     that does not see the known task tables.
//   * The PASS line starts with TASKS_API_DB_SMOKE_PASS. Tokens are never printed.

import { pathToFileURL } from 'node:url'

// --- pure helpers (exported for the companion .test.mjs) -----------------------------------

export const STAMP_PATTERN = /^tasks-smoke-[A-Za-z0-9-]+$/

// Task tables the residue enumeration must see; a smaller enumerated set fails the run.
export const KNOWN_TASK_ID_TABLES = ['task_assignees', 'task_comments', 'task_events', 'task_followers']

export function isStampedId(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length
}

export function jwtSubject(jwt) {
  try {
    const seg = String(jwt).split('.')[1]
    if (!seg) return null
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'))
    // Same claim order as the backend's token verification (userId, then id, then sub).
    return payload.userId || payload.id || payload.sub || null
  } catch {
    return null
  }
}

// A role id ending "_admin" (other than the literal "admin") grants implicit delegated-admin
// namespace control (namespace-admission.ts deriveDelegatedAdminNamespace); no smoke role may
// have that shape.
export function assertNotAdminRoleId(roleId) {
  if (roleId.endsWith('_admin')) {
    throw new Error(`refusing to use a role id ending "_admin" for a non-admin smoke subject: ${roleId}`)
  }
  return roleId
}

export function roleIdForStamp(stamp) {
  return assertNotAdminRoleId(`${stamp}-role`)
}

export function memberIdForStamp(stamp) {
  return `${stamp}-member`
}

export function outsiderIdForStamp(stamp) {
  return `${stamp}-outsider`
}

export function outsiderRoleIdForStamp(stamp) {
  return assertNotAdminRoleId(`${stamp}-outsider-role`)
}

// SQL identifier quoting: wrap in double quotes, double any embedded double quote.
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

// Env-only contract (no CLI args): BASE_URL/DATABASE_URL required, DEPLOY_SHA mandatory (the
// PASS stamp names the build actually smoked), STAMP regex-locked so cleanup stays synthetic and
// LIKE-free.
export function resolveEnvConfig(env = {}) {
  const errors = []
  const baseUrl = String(env.BASE_URL || env.BASE || '').replace(/\/$/, '')
  const databaseUrl = String(env.DATABASE_URL || '')
  const orgId = String(env.ORG_ID || 'default')
  const deploySha = String(env.DEPLOY_SHA || env.EXPECTED_DEPLOY_SHA || '')
  if (!baseUrl || !databaseUrl) {
    errors.push('BASE_URL and DATABASE_URL are required.')
  }
  if (!deploySha || deploySha === '<fill-from-staging-build>') {
    errors.push('DEPLOY_SHA is required so the PASS stamp names the staging build that was actually smoked.')
  }
  const suffix = Date.now().toString(36)
  const stamp = String(env.STAMP || `tasks-smoke-${suffix}`)
  if (!STAMP_PATTERN.test(stamp)) {
    errors.push('STAMP must match /^tasks-smoke-[A-Za-z0-9-]+$/ so cleanup remains visibly synthetic and LIKE-free.')
  }
  return {
    ok: errors.length === 0,
    errors,
    config: { baseUrl, databaseUrl, orgId, deploySha, stamp, suffix },
  }
}

// --- runtime wiring -------------------------------------------------------------------------

const IS_MAIN = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
const ENTRY = resolveEnvConfig(process.env)
if (IS_MAIN && !ENTRY.ok) {
  for (const message of ENTRY.errors) console.error(`FAIL: ${message}`)
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet DEPLOY_SHA=<deployed-sha> SUBJECT_TOKEN=<jwt> MEMBER_TOKEN=<jwt> OUTSIDER_TOKEN=<jwt> node scripts/ops/staging-tasks-smoke.mjs')
  process.exit(2)
}

const { baseUrl: BASE_URL, databaseUrl: DATABASE_URL, orgId: ORG_ID, deploySha: DEPLOY_SHA, stamp: STAMP } = ENTRY.config
const USER_ID = STAMP
const ROLE_ID = roleIdForStamp(STAMP)
const MEMBER_ID = memberIdForStamp(STAMP)
const OUTSIDER_ID = outsiderIdForStamp(STAMP)
const OUTSIDER_ROLE_ID = outsiderRoleIdForStamp(STAMP)
const SEEDED_USER_IDS = [USER_ID, MEMBER_ID, OUTSIDER_ID]
const SEEDED_ROLE_IDS = [ROLE_ID, OUTSIDER_ROLE_ID]

let subjectToken = process.env.SUBJECT_TOKEN || ''
let memberToken = process.env.MEMBER_TOKEN || ''
let outsiderToken = process.env.OUTSIDER_TOKEN || ''
let cleanupAllowed = false
let pass = 0
const failures = []
// The run's task ids, for the residue counts only (no DELETE reads them). Every id here was read
// from the DB as a task a seeded identity created: a created task's id once its ownership check
// passed, and every id the cleanup's collect query reads before its DELETEs (kept across passes).
const runTaskIds = new Set()

let pool = null
const q = (text, params = []) => pool.query(text, params).then((result) => result.rows)

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

// A step whose later steps depend on its status fails the run at once.
function expectStatus(res, status, label) {
  ok(res.status === status, `${label} -> ${status} (status ${res.status})`, res.body)
  if (res.status !== status) {
    throw new Error(`${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`)
  }
}

function authHeaders(token) {
  const headers = { 'Content-Type': 'application/json', 'x-org-id': ORG_ID }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function api(token, pathname, { method = 'GET', body } = {}) {
  const url = new URL(`${BASE_URL}${pathname}`)
  const res = await fetch(url, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* non-json */ }
  return { status: res.status, body: json }
}

const taskPath = (taskId, suffix = '') => `/api/tasks/${encodeURIComponent(taskId)}${suffix}`

async function mintToken(userId, perms) {
  const res = await api('', `/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=user&perms=${encodeURIComponent(perms)}&tenantId=${encodeURIComponent(ORG_ID)}`)
  const token = res.body?.token || ''
  if (!token) {
    throw new Error(`could not mint dev-token for ${userId} (status ${res.status}); provide explicit SUBJECT_TOKEN, MEMBER_TOKEN and OUTSIDER_TOKEN where the dev-token route is not mounted (production node-env)`)
  }
  return token
}

async function resolveToken(label, supplied, userId, perms) {
  if (supplied) {
    const subject = jwtSubject(supplied)
    if (subject !== userId) {
      throw new Error(`${label} subject "${subject}" does not equal its identity "${userId}"`)
    }
    console.log(`  using supplied ${label} (subject ${subject})`)
    return supplied
  }
  const token = await mintToken(userId, perms)
  console.log(`  minted ${label} dev-token (subject ${userId})`)
  return token
}

async function resolveTokens() {
  subjectToken = await resolveToken('SUBJECT_TOKEN', subjectToken, USER_ID, 'tasks:read,tasks:write')
  memberToken = await resolveToken('MEMBER_TOKEN', memberToken, MEMBER_ID, 'tasks:read,tasks:write')
  outsiderToken = await resolveToken('OUTSIDER_TOKEN', outsiderToken, OUTSIDER_ID, 'tasks:read')
}

// --- preflight ---------------------------------------------------------------------------

/** Tables the task routes read since M4 PR-3a (role resolution and /pending-count). */
export const M4_TASK_TABLES = Object.freeze(['task_list_items', 'task_list_members', 'task_user_settings'])

async function preflightDatabase() {
  const row = (await q(
    `SELECT
       to_regclass('public.users') IS NOT NULL AS users_ok,
       to_regclass('public.user_orgs') IS NOT NULL AS user_orgs_ok,
       to_regclass('public.roles') IS NOT NULL AS roles_ok,
       to_regclass('public.role_permissions') IS NOT NULL AS role_permissions_ok,
       to_regclass('public.user_roles') IS NOT NULL AS user_roles_ok,
       to_regclass('public.permissions') IS NOT NULL AS permissions_ok,
       to_regclass('public.user_namespace_admissions') IS NOT NULL AS admissions_ok,
       to_regclass('public.tasks') IS NOT NULL AS tasks_ok,
       to_regclass('public.task_assignees') IS NOT NULL AS task_assignees_ok,
       to_regclass('public.task_followers') IS NOT NULL AS task_followers_ok,
       to_regclass('public.task_events') IS NOT NULL AS task_events_ok,
       to_regclass('public.task_comments') IS NOT NULL AS task_comments_ok`,
  ))[0] || {}
  const tablesReady = Object.values(row).every((value) => value === true)
  ok(tablesReady, 'DB assertion channel reachable and the P0-A and M3 task tables exist', row)
  if (!tablesReady) throw new Error('staging DB is missing task tables (or RBAC tables), or DATABASE_URL points at the wrong database: the tasks migrations may not be applied yet')

  // M4 PR-3a: this image's task routes read three M4 tables on every role resolution and on
  // /pending-count, so without the M4 migration they answer 500 (42P01). Refuse here, by name,
  // instead of surfacing that as an HTTP assertion failure further down.
  const m4Row = (await q(
    `SELECT
       to_regclass('public.task_list_items') IS NOT NULL AS task_list_items_ok,
       to_regclass('public.task_list_members') IS NOT NULL AS task_list_members_ok,
       to_regclass('public.task_user_settings') IS NOT NULL AS task_user_settings_ok`,
  ))[0] || {}
  const m4Ready = M4_TASK_TABLES.every((table) => m4Row[`${table}_ok`] === true)
  ok(m4Ready, 'M4 task tables exist (task_list_items, task_list_members, task_user_settings)', m4Row)
  if (!m4Ready) {
    const missing = M4_TASK_TABLES.filter((table) => m4Row[`${table}_ok`] !== true)
    throw new Error(`M4 task tables do not exist (${missing.join(', ')}): the task routes in this image need the M4 migration`)
  }

  const permRow = (await q(
    `SELECT count(*)::int AS n FROM permissions WHERE code IN ('tasks:read', 'tasks:write')`,
  ))[0] || {}
  const permsReady = Number(permRow.n) === 2
  ok(permsReady, 'permission catalog carries tasks:read and tasks:write (role_permissions FK precondition)', permRow)
  if (!permsReady) throw new Error('permissions table is missing tasks:read/tasks:write: a role_permissions insert would fail its FK (23503), not 403')
}

// Rows keyed by a seeded identity, in every identity table and in the task tables by user.
async function identityResidue() {
  return (await q(
    `SELECT
       (SELECT count(*)::int FROM users WHERE id = ANY($1::text[])) AS users,
       (SELECT count(*)::int FROM user_orgs WHERE user_id = ANY($1::text[])) AS user_orgs,
       (SELECT count(*)::int FROM user_roles WHERE user_id = ANY($1::text[]) OR role_id = ANY($2::text[])) AS user_roles,
       (SELECT count(*)::int FROM user_namespace_admissions WHERE user_id = ANY($1::text[])) AS admissions,
       (SELECT count(*)::int FROM roles WHERE id = ANY($2::text[])) AS roles,
       (SELECT count(*)::int FROM role_permissions WHERE role_id = ANY($2::text[])) AS role_permissions,
       (SELECT count(*)::int FROM tasks WHERE created_by = ANY($1::text[])) AS tasks_by_creator,
       (SELECT count(*)::int FROM task_assignees WHERE user_id = ANY($1::text[])) AS task_assignees_by_user,
       (SELECT count(*)::int FROM task_followers WHERE user_id = ANY($1::text[])) AS task_followers_by_user,
       (SELECT count(*)::int FROM task_comments WHERE author_id = ANY($1::text[])) AS task_comments_by_author,
       (SELECT count(*)::int FROM task_events WHERE actor_id = ANY($1::text[])) AS task_events_by_actor`,
    [SEEDED_USER_IDS, SEEDED_ROLE_IDS],
  ))[0] || {}
}

const allZero = (counts) => Object.keys(counts).length > 0 && Object.values(counts).every((value) => Number(value) === 0)

async function preflightNoExistingResidue() {
  const row = await identityResidue()
  const clean = allZero(row)
  ok(clean, 'no pre-existing rows for any identity of this stamp', row)
  if (!clean) throw new Error(`pre-existing residue found for ${STAMP}; use a fresh STAMP or inspect before running`)
}

// --- seed ------------------------------------------------------------------------------------

async function seedIdentities() {
  for (const roleId of SEEDED_ROLE_IDS) assertNotAdminRoleId(roleId)
  for (const userId of SEEDED_USER_IDS) {
    if (!isStampedId(userId, 'tasks-smoke-')) {
      throw new Error(`refusing to run: identity "${userId}" is not stamped tasks-smoke-. This smoke deletes its synthetic identities during cleanup.`)
    }
  }
  // Armed before the first INSERT: preflightNoExistingResidue proved no row exists for these
  // ids (no task created by any of them either), and every cleanup statement is keyed on them -
  // task rows by created_by, never by an id an API answer carried - so cleanup removes only this
  // run's rows.
  cleanupAllowed = true
  await pool.query(
    'INSERT INTO roles (id, name) VALUES ($1, $1), ($2, $2) ON CONFLICT (id) DO NOTHING',
    [ROLE_ID, OUTSIDER_ROLE_ID],
  )
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_code)
     VALUES ($1, 'tasks:read'), ($1, 'tasks:write'), ($2, 'tasks:read')
     ON CONFLICT DO NOTHING`,
    [ROLE_ID, OUTSIDER_ROLE_ID],
  )
  for (const userId of SEEDED_USER_IDS) {
    await pool.query(
      `INSERT INTO users (
         id, email, name, password_hash, role, permissions,
         is_active, activation_status, local_password_set, must_change_password
       )
       VALUES ($1, $2, $3, 'no-login', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = true, email = EXCLUDED.email, name = EXCLUDED.name`,
      [userId, `${userId}@example.test`, userId],
    )
  }
  // The member shares the subject's role (tasks:read, tasks:write): it needs tasks:write only to
  // leave a task it follows.
  await pool.query(
    'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $2), ($4, $5) ON CONFLICT DO NOTHING',
    [USER_ID, ROLE_ID, MEMBER_ID, OUTSIDER_ID, OUTSIDER_ROLE_ID],
  )
  for (const userId of SEEDED_USER_IDS) {
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
      [userId, ORG_ID],
    )
  }
  await grantAdmission(MEMBER_ID)
  await grantAdmission(OUTSIDER_ID)
  ok(true, 'seeded subject (role, no admission yet), member (subject role + admission) and outsider (tasks:read role + admission)', {
    subject: USER_ID, member: MEMBER_ID, outsider: OUTSIDER_ID, roles: SEEDED_ROLE_IDS,
  })
}

async function grantAdmission(userId) {
  await pool.query(
    `INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source, granted_by, updated_by, created_at, updated_at)
     VALUES ($1, 'tasks', TRUE, 'staging_window_runner_smoke', $1, $1, now(), now())
     ON CONFLICT (user_id, namespace) DO UPDATE SET enabled = TRUE, updated_at = now()`,
    [userId],
  )
}

// --- gate + P0-A -------------------------------------------------------------------------------

async function checkNamespaceAdmissionGate() {
  const res = await api(subjectToken, '/api/tasks/context')
  if (res.status === 404) {
    throw new Error('GET /api/tasks/context -> 404: TASKS_ENABLED is not live on the running backend (tasksRouter() returned null)')
  }
  if (res.status === 401) {
    throw new Error(`GET /api/tasks/context -> 401: this smoke's own auth/tenant seed is wrong (not the namespace-admission gate under test) - body: ${JSON.stringify(res.body)}`)
  }
  ok(res.status === 403, 'GET /api/tasks/context is 403 BEFORE the namespace admission row exists (role_permissions+user_roles alone must be insufficient)', res.body)
  if (res.status !== 403) {
    throw new Error(`SECURITY: expected 403 without a user_namespace_admissions row, got ${res.status} - the namespace-admission AND gate did not hold`)
  }
}

async function checkContext() {
  const res = await api(subjectToken, '/api/tasks/context')
  ok(res.status === 200, `GET /api/tasks/context -> 200 (status ${res.status})`, res.body)
  ok(res.body?.orgId === ORG_ID, `context orgId resolves to the tenant claim (${ORG_ID})`, res.body)
}

async function createOneTask(title) {
  const res = await api(subjectToken, '/api/tasks', { method: 'POST', body: { title } })
  ok(res.status === 200, `POST /api/tasks -> 200 (status ${res.status})`, res.body)
  const id = res.body?.id
  ok(typeof id === 'string' && id.length > 0, 'created task carries an id', res.body)
  if (typeof id !== 'string' || id.length === 0) throw new Error(`POST /api/tasks did not return an id: ${JSON.stringify(res.body)}`)
  // The answered id is used only once the DB holds it as this run's task: created by the subject,
  // with the title this run sent, in ORG_ID. Any other id (another user's task, an earlier task of
  // this run) stops the run here and is not added to the run's task ids.
  const owned = (await q(
    'SELECT count(*)::int AS n FROM tasks WHERE id = $1 AND created_by = $2 AND title = $3 AND org_id = $4',
    [id, USER_ID, title, ORG_ID],
  ))[0] || {}
  const isOwn = Number(owned.n) === 1
  ok(isOwn, `the DB holds the created task as the subject's, with the title it sent, in org ${ORG_ID}`, { id })
  if (!isOwn) {
    throw new Error(`POST /api/tasks answered id ${JSON.stringify(id)}, which the DB does not hold as a task ${USER_ID} created in org ${ORG_ID} with the title this run sent; the run does not use that id, and cleanup and residue cover only the tasks the seeded identities created`)
  }
  runTaskIds.add(id)
  return id
}

async function checkListedInCreatedView(taskId) {
  const res = await api(subjectToken, '/api/tasks?view=created')
  ok(res.status === 200, `GET /api/tasks?view=created -> 200 (status ${res.status})`, res.body)
  const ids = Array.isArray(res.body?.items) ? res.body.items.map((row) => row.id) : []
  ok(ids.includes(taskId), 'created task is visible under view=created', { taskId, ids })
}

async function completeThenReopen(taskId) {
  const complete = await api(subjectToken, taskPath(taskId, '/complete'), { method: 'POST' })
  ok(complete.status === 200, `POST /api/tasks/:id/complete -> 200 (status ${complete.status})`, complete.body)
  ok(complete.body?.done === true, 'complete transitions the single-assignee task to done', complete.body)

  const reopen = await api(subjectToken, taskPath(taskId, '/reopen'), { method: 'POST', body: { scope: 'self' } })
  ok(reopen.status === 200, `POST /api/tasks/:id/reopen {scope:'self'} -> 200 (status ${reopen.status})`, reopen.body)
  ok(reopen.body?.ok === true, 'reopen acknowledges', reopen.body)
}

async function checkFullRead(taskId) {
  const res = await api(subjectToken, taskPath(taskId))
  ok(res.status === 200, `GET /api/tasks/:id -> 200 (status ${res.status})`, res.body)
  ok(res.body?.id === taskId, 'read-back id matches the created task', res.body)
  ok(res.body?.status === 'open', 'the reopened task reads back open', res.body?.status)
}

// --- M3 ----------------------------------------------------------------------------------------

async function readTask(taskId, label) {
  const res = await api(subjectToken, taskPath(taskId))
  expectStatus(res, 200, `GET /api/tasks/:id (${label})`)
  return res.body
}

// A list field read from an answer: null unless the answer carries the list, so a missing or
// malformed field never passes as "not listed".
const childIdsOf = (task) => (Array.isArray(task?.children) ? task.children.map((child) => child?.id) : null)
const assigneeIdsOf = (body) => (Array.isArray(body?.assignees) ? body.assignees.map((row) => row?.userId) : null)
const followersOf = (body) => (Array.isArray(body?.followers) ? body.followers : null)
const listed = (list, value) => Array.isArray(list) && list.includes(value)
const unlisted = (list, value) => Array.isArray(list) && !list.includes(value)

// GET /api/tasks/:id/parent-candidates: the org's live tasks other than the task and its
// descendants, limited to the tasks the caller can edit, as [{id, title}].
async function parentCandidates(taskId, label) {
  const res = await api(subjectToken, taskPath(taskId, '/parent-candidates'))
  expectStatus(res, 200, `GET /api/tasks/:id/parent-candidates (${label})`)
  return res.body?.items
}

async function setParent(childId, parentId, label) {
  const res = await api(subjectToken, taskPath(childId, '/parent'), { method: 'PATCH', body: { parentId } })
  expectStatus(res, 200, `PATCH /api/tasks/:id/parent (${label})`)
  return res.body
}

async function checkSubtask(parentId, childId) {
  // The subject is a fresh identity: the only other task it can edit is the parent.
  const candidates = await parentCandidates(childId, 'child')
  ok(
    Array.isArray(candidates) && candidates.length === 1 && candidates[0]?.id === parentId && candidates[0]?.title === STAMP,
    "the child's parent candidates are exactly the parent {id, title}",
    candidates,
  )

  const set = await setParent(childId, parentId, 'set')
  ok(set?.id === childId && set?.parentId === parentId && set?.depth === 1, 'set-parent answers {id, parentId: parent, depth: 1}', set)
  let child = await readTask(childId, 'child after set-parent')
  ok(child?.parentId === parentId && child?.depth === 1, 'the child reads back parentId = parent and depth 1', { parentId: child?.parentId, depth: child?.depth })
  let parent = await readTask(parentId, 'parent after set-parent')
  const listedChild = Array.isArray(parent?.children) ? parent.children.find((row) => row?.id === childId) : undefined
  ok(listedChild?.depth === 1, 'the parent reads back the child under children with depth 1', parent?.children)
  const parentOwnCandidates = await parentCandidates(parentId, 'parent with its child set')
  ok(Array.isArray(parentOwnCandidates) && parentOwnCandidates.length === 0, "the parent's candidates leave out itself and its own child, so none are left", parentOwnCandidates)

  const cleared = await setParent(childId, null, 'clear')
  ok(cleared?.id === childId && cleared?.parentId === null && cleared?.depth === 0, 'clear-parent answers {id, parentId: null, depth: 0}', cleared)
  child = await readTask(childId, 'child after clear-parent')
  ok(child?.parentId === null && child?.depth === 0, 'the child reads back parentId null and depth 0', { parentId: child?.parentId, depth: child?.depth })
  parent = await readTask(parentId, 'parent after clear-parent')
  ok(unlisted(childIdsOf(parent), childId), 'the parent no longer lists the child', parent?.children)

  const again = await setParent(childId, parentId, 'set again')
  ok(again?.parentId === parentId && again?.depth === 1, 'set-parent again answers depth 1', again)
  child = await readTask(childId, 'child after the second set-parent')
  ok(child?.parentId === parentId && child?.depth === 1, 'the child reads back the parent again', { parentId: child?.parentId, depth: child?.depth })
}

async function checkAssigneeAddRemove(taskId) {
  const add = await api(subjectToken, taskPath(taskId, '/assignees'), { method: 'POST', body: { userId: MEMBER_ID } })
  expectStatus(add, 200, 'POST /api/tasks/:id/assignees (member)')
  ok(add.body?.id === taskId && add.body?.status === 'open', 'add-assignee answers the open task', add.body)
  ok(listed(assigneeIdsOf(add.body), MEMBER_ID) && listed(assigneeIdsOf(add.body), USER_ID), 'add-assignee answers both the subject and the member as assignees', add.body?.assignees)
  let task = await readTask(taskId, 'after add-assignee')
  ok(listed(assigneeIdsOf(task), MEMBER_ID), 'the task reads back the member as an assignee', task?.assignees)

  const remove = await api(subjectToken, taskPath(taskId, `/assignees/${encodeURIComponent(MEMBER_ID)}`), { method: 'DELETE' })
  expectStatus(remove, 200, 'DELETE /api/tasks/:id/assignees/:userId (member)')
  ok(unlisted(assigneeIdsOf(remove.body), MEMBER_ID) && listed(assigneeIdsOf(remove.body), USER_ID), 'remove-assignee answers the subject without the member', remove.body?.assignees)
  ok(remove.body?.status === 'open', 'remove-assignee leaves the task open (the remaining assignee has not completed)', remove.body)
  task = await readTask(taskId, 'after remove-assignee')
  ok(unlisted(assigneeIdsOf(task), MEMBER_ID), 'the task no longer reads back the member as an assignee', task?.assignees)
}

async function checkFollowerAddRemove(taskId) {
  const add = await api(subjectToken, taskPath(taskId, '/followers'), { method: 'POST', body: { userId: MEMBER_ID } })
  expectStatus(add, 200, 'POST /api/tasks/:id/followers (member)')
  ok(add.body?.id === taskId && listed(followersOf(add.body), MEMBER_ID), 'add-follower answers the member among the followers', add.body)
  let task = await readTask(taskId, 'after add-follower')
  ok(listed(followersOf(task), MEMBER_ID), 'the task reads back the member as a follower', task?.followers)

  const remove = await api(subjectToken, taskPath(taskId, `/followers/${encodeURIComponent(MEMBER_ID)}`), { method: 'DELETE' })
  expectStatus(remove, 200, 'DELETE /api/tasks/:id/followers/:userId (member)')
  ok(remove.body?.id === taskId && unlisted(followersOf(remove.body), MEMBER_ID), 'remove-follower answers the followers without the member', remove.body)
  task = await readTask(taskId, 'after remove-follower')
  ok(unlisted(followersOf(task), MEMBER_ID), 'the task no longer reads back the member as a follower', task?.followers)
}

// POST /api/tasks/:id/leave: the caller removes itself from the followers. It needs tasks:write
// and the follower-only `leave` ability, so the member, followed again, leaves with its own token.
async function checkFollowerLeave(taskId) {
  const again = await api(subjectToken, taskPath(taskId, '/followers'), { method: 'POST', body: { userId: MEMBER_ID } })
  expectStatus(again, 200, 'POST /api/tasks/:id/followers (member, again)')
  ok(again.body?.id === taskId && listed(followersOf(again.body), MEMBER_ID), 'add-follower again answers the member among the followers', again.body)
  const left = await api(memberToken, taskPath(taskId, '/leave'), { method: 'POST' })
  expectStatus(left, 200, 'POST /api/tasks/:id/leave (member)')
  ok(left.body?.id === taskId && unlisted(followersOf(left.body), MEMBER_ID), "the member's leave answers the followers without the member", left.body)
  const task = await readTask(taskId, 'after the member left')
  ok(unlisted(followersOf(task), MEMBER_ID), 'after the member leaves, the task no longer reads back the member as a follower', task?.followers)
}

async function switchCompletionMode(taskId, mode) {
  const res = await api(subjectToken, taskPath(taskId, '/completion-mode'), { method: 'PATCH', body: { completionMode: mode } })
  expectStatus(res, 200, `PATCH /api/tasks/:id/completion-mode (${mode})`)
  ok(res.body?.id === taskId && res.body?.completionMode === mode, `completion-mode switch answers completionMode '${mode}'`, res.body)
  ok(res.body?.status === 'open', `the switch to '${mode}' leaves the task open (no assignee has completed)`, res.body)
  const task = await readTask(taskId, `after completion-mode ${mode}`)
  ok(task?.completionMode === mode, `the task reads back completionMode '${mode}'`, task?.completionMode)
}

async function checkCompletionModeSwitch(taskId) {
  await switchCompletionMode(taskId, 'any')
  await switchCompletionMode(taskId, 'all')
}

async function checkComments(taskId) {
  const text = `${STAMP} comment`
  const editedText = `${STAMP} comment edited`
  const created = await api(subjectToken, taskPath(taskId, '/comments'), { method: 'POST', body: { body: text } })
  expectStatus(created, 200, 'POST /api/tasks/:id/comments')
  const commentId = created.body?.id
  ok(
    typeof commentId === 'string' && created.body?.taskId === taskId && created.body?.authorId === USER_ID
      && created.body?.body === text && created.body?.deleted === false,
    'the new comment answers its id, task, author and body',
    created.body,
  )
  if (typeof commentId !== 'string' || commentId.length === 0) throw new Error(`POST /api/tasks/:id/comments did not return an id: ${JSON.stringify(created.body)}`)

  const edited = await api(subjectToken, taskPath(taskId, `/comments/${encodeURIComponent(commentId)}`), { method: 'PATCH', body: { body: editedText } })
  expectStatus(edited, 200, 'PATCH /api/tasks/:id/comments/:commentId')
  ok(edited.body?.id === commentId && edited.body?.body === editedText && edited.body?.deleted === false, 'the edited comment answers the new body', edited.body)
  // The edit is read back, not only answered: a backend that answers the new body without storing
  // it still lists the old one.
  const afterEdit = await api(subjectToken, taskPath(taskId, '/comments'))
  expectStatus(afterEdit, 200, 'GET /api/tasks/:id/comments (after the edit)')
  const editedRow = Array.isArray(afterEdit.body?.items) ? afterEdit.body.items.find((item) => item?.id === commentId) : undefined
  ok(editedRow?.body === editedText && editedRow?.deleted === false, 'the edited comment reads back with the new body', editedRow)

  const removed = await api(subjectToken, taskPath(taskId, `/comments/${encodeURIComponent(commentId)}`), { method: 'DELETE' })
  expectStatus(removed, 200, 'DELETE /api/tasks/:id/comments/:commentId')
  ok(removed.body?.id === commentId && removed.body?.deleted === true && removed.body?.body === null, 'the deleted comment answers the tombstone shape (deleted: true, body: null)', removed.body)

  const list = await api(subjectToken, taskPath(taskId, '/comments'))
  expectStatus(list, 200, 'GET /api/tasks/:id/comments (after the delete)')
  const row = Array.isArray(list.body?.items) ? list.body.items.find((item) => item?.id === commentId) : undefined
  ok(row?.deleted === true && row?.body === null, 'the deleted comment reads back as a tombstone', row)
  ok(list.body?.total === 1, 'the tombstone still counts in total', list.body?.total)
}

async function checkOutsider(taskId) {
  const context = await api(outsiderToken, '/api/tasks/context')
  if (context.status === 403) {
    throw new Error('outsider GET /api/tasks/context -> 403: the outsider is not admitted to the tasks namespace (seed or grant broken), so its row-level check would prove nothing')
  }
  expectStatus(context, 200, 'outsider GET /api/tasks/context')
  ok(context.body?.orgId === ORG_ID, `the outsider's tenant claim resolves to ${ORG_ID}`, context.body)
  if (context.body?.orgId !== ORG_ID) {
    throw new Error(`outsider context orgId is ${JSON.stringify(context.body?.orgId)}, not ${ORG_ID}: a 404 on the task would be org-missing, not row-level`)
  }

  const read = await api(outsiderToken, taskPath(taskId))
  if (read.status === 200) {
    throw new Error('SECURITY: an admitted tasks:read user with no relation to the task read it (200) - row-level visibility did not hold')
  }
  if (read.status === 403) {
    throw new Error('outsider GET /api/tasks/:id -> 403: the RBAC gate refused the admitted outsider, so the row-level 404 was never exercised')
  }
  ok(read.status === 404 && read.body?.error?.code === 'NOT_FOUND', 'an admitted tasks:read user with no relation to the task gets 404 NOT_FOUND', read)
  if (read.status !== 404) throw new Error(`outsider GET /api/tasks/:id: expected 404, got ${read.status} ${JSON.stringify(read.body)}`)
}

async function checkDelete(parentId, childId) {
  const blocked = await api(subjectToken, taskPath(parentId), { method: 'DELETE' })
  ok(blocked.status === 409 && blocked.body?.error?.code === 'HAS_CHILDREN', 'DELETE of the parent while its child is live is 409 HAS_CHILDREN', blocked)
  if (blocked.status !== 409) throw new Error(`DELETE parent with a live child: expected 409 HAS_CHILDREN, got ${blocked.status} ${JSON.stringify(blocked.body)}`)

  for (const [taskId, label] of [[childId, 'child'], [parentId, 'parent']]) {
    const res = await api(subjectToken, taskPath(taskId), { method: 'DELETE' })
    expectStatus(res, 200, `DELETE /api/tasks/:id (${label})`)
    ok(res.body?.id === taskId && res.body?.deleted === true, `deleting the ${label} answers {id, deleted: true}`, res.body)
  }
  for (const [taskId, label] of [[parentId, 'parent'], [childId, 'child']]) {
    const res = await api(subjectToken, taskPath(taskId))
    ok(res.status === 404 && res.body?.error?.code === 'NOT_FOUND', `reading the deleted ${label} is 404 NOT_FOUND`, res)
    if (res.status !== 404) throw new Error(`GET deleted ${label}: expected 404, got ${res.status}`)
  }
}

// --- cleanup + residue -----------------------------------------------------------------------

async function cleanup() {
  const errors = []
  if (!cleanupAllowed) return errors
  const run = async (label, text, params) => {
    try {
      await pool.query(text, params)
    } catch (error) {
      errors.push(`${label}: ${error?.message || error}`)
    }
  }
  // The run's task ids for the residue counts, read before the DELETEs remove them.
  try {
    const rows = await q('SELECT id FROM tasks WHERE created_by = ANY($1::text[])', [SEEDED_USER_IDS])
    for (const row of rows) runTaskIds.add(String(row.id))
  } catch (error) {
    errors.push(`collect task ids: ${error?.message || error}`)
  }
  // Every task DELETE selects its rows by the seeded creators, in the statement itself; no DELETE
  // takes a task id from an API answer or from runTaskIds. Children of tasks first (they also
  // cascade from tasks), then the tasks in ONE statement: the self-referencing parent FK (NO
  // ACTION) is checked at statement end, so a parent and its children are removed together.
  const ownTasks = 'SELECT id FROM tasks WHERE created_by = ANY($1::text[])'
  await run('task_comments', `DELETE FROM task_comments WHERE task_id IN (${ownTasks})`, [SEEDED_USER_IDS])
  await run('task_events', `DELETE FROM task_events WHERE task_id IN (${ownTasks})`, [SEEDED_USER_IDS])
  await run('task_followers', `DELETE FROM task_followers WHERE task_id IN (${ownTasks})`, [SEEDED_USER_IDS])
  await run('task_assignees', `DELETE FROM task_assignees WHERE task_id IN (${ownTasks})`, [SEEDED_USER_IDS])
  await run('tasks', 'DELETE FROM tasks WHERE created_by = ANY($1::text[])', [SEEDED_USER_IDS])
  // Every user_roles row of a seeded user, not only the seeded role: token verification may add
  // a self-service role row (AuthService.resolveRbacProfile).
  await run('user_namespace_admissions', 'DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [SEEDED_USER_IDS])
  await run('user_roles', 'DELETE FROM user_roles WHERE user_id = ANY($1::text[]) OR role_id = ANY($2::text[])', [SEEDED_USER_IDS, SEEDED_ROLE_IDS])
  await run('user_orgs', 'DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [SEEDED_USER_IDS])
  await run('users', 'DELETE FROM users WHERE id = ANY($1::text[])', [SEEDED_USER_IDS])
  await run('role_permissions', 'DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [SEEDED_ROLE_IDS])
  await run('roles', 'DELETE FROM roles WHERE id = ANY($1::text[])', [SEEDED_ROLE_IDS])
  return errors
}

async function taskIdTables() {
  const rows = await q(
    `SELECT c.table_name
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'task_id' AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name`,
  )
  return rows.map((row) => String(row.table_name))
}

// Flat map of every residue count: identity tables by seeded user/role, every public base table
// with a task_id column by the run's task ids (task_id compared as text, so a non-text task_id
// column is counted rather than erroring), and the tasks rows by id. The run's task ids are the
// tasks the seeded identities created, as read from the DB; an id only an API answer named is
// never counted, so a task the run did not create cannot read as residue or as clean.
async function residueCounts() {
  const counts = {}
  for (const [name, value] of Object.entries(await identityResidue())) counts[name] = Number(value)
  const taskIds = [...runTaskIds]
  const tables = await taskIdTables()
  const missing = KNOWN_TASK_ID_TABLES.filter((table) => !tables.includes(table))
  if (missing.length > 0) {
    throw new Error(`residue enumeration did not see the task tables ${missing.join(', ')}; refusing a residue verdict over a smaller population`)
  }
  for (const table of tables) {
    const row = (await q(
      `SELECT count(*)::int AS n FROM public.${quoteIdent(table)} WHERE ${quoteIdent('task_id')}::text = ANY($1::text[])`,
      [taskIds],
    ))[0] || {}
    counts[`${table}.task_id`] = Number(row.n)
  }
  const taskRow = (await q('SELECT count(*)::int AS n FROM tasks WHERE id = ANY($1::text[])', [taskIds]))[0] || {}
  counts['tasks.id'] = Number(taskRow.n)
  return counts
}

function nonZero(counts) {
  return Object.fromEntries(Object.entries(counts).filter(([, value]) => Number(value) !== 0))
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  console.log(`tasks API/DB staging smoke helper @ ${BASE_URL}`)
  console.log(`  deploy=${DEPLOY_SHA} org=${ORG_ID} stamp=${STAMP} subject=${USER_ID} member=${MEMBER_ID} outsider=${OUTSIDER_ID} roles=${SEEDED_ROLE_IDS.join(',')}`)

  await preflightDatabase()
  await preflightNoExistingResidue()
  await seedIdentities()
  await resolveTokens()

  await checkNamespaceAdmissionGate()
  await grantAdmission(USER_ID)
  ok(true, 'granted user_namespace_admissions(tasks, enabled=true) to the subject', { user: USER_ID })

  await checkContext()
  const parentId = await createOneTask(STAMP)
  await checkListedInCreatedView(parentId)
  await completeThenReopen(parentId)
  await checkFullRead(parentId)

  const childId = await createOneTask(`${STAMP} child`)
  await checkSubtask(parentId, childId)
  await checkAssigneeAddRemove(parentId)
  await checkFollowerAddRemove(parentId)
  await checkFollowerLeave(parentId)
  await checkCompletionModeSwitch(parentId)
  await checkComments(parentId)
  await checkOutsider(parentId)
  await checkDelete(parentId, childId)

  const cleanupErrors = await cleanup()
  for (const message of cleanupErrors) console.error(`  WARN  cleanup statement failed: ${message}`)
  const residue = await residueCounts()
  const residueOk = allZero(residue)
  ok(residueOk, `cleanup residue is zero across ${Object.keys(residue).length} counts (identity tables + every task_id table + tasks)`, residueOk ? undefined : nonZero(residue))
  if (!residueOk) throw new Error(`residue not zero: ${JSON.stringify(nonZero(residue))}`)
  if (failures.length) {
    throw new Error(`tasks API/DB smoke had ${failures.length} failed assertion(s): ${failures.join('; ')}`)
  }

  console.log(`TASKS_API_DB_SMOKE_PASS deploy=${DEPLOY_SHA} stamp=${STAMP} org=${ORG_ID} task=${parentId} residue=0`)
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
      // Cleanup's own outcome is reported separately from the primary failure above.
      try {
        const cleanupErrors = await cleanup()
        for (const message of cleanupErrors) console.error(`  WARN  cleanup statement failed: ${message}`)
        if (cleanupAllowed) {
          const residue = await residueCounts()
          const residueOk = allZero(residue)
          console.error(`Residue after best-effort cleanup: ${JSON.stringify(residueOk ? {} : nonZero(residue))} (clean=${residueOk})`)
        }
      } catch (cleanupError) {
        console.error(`FAIL: best-effort cleanup itself failed: ${cleanupError?.message || cleanupError}`)
      }
      process.exitCode = 1
    })
    .finally(async () => {
      await pool.end().catch(() => undefined)
    })
}
