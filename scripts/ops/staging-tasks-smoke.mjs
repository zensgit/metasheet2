#!/usr/bin/env node
// Tasks (P0-A) staging smoke helper — non-admin RBAC gate + create/list/complete/reopen/read
// HTTP surface for the /api/tasks routes (owner-authorized 2026-09-28: "改 staging
// window-runner 加 tasks_enabled 输入...非管理员冒烟").
//
// This helper drives the real staging HTTP API for every check (never calls task-records.ts
// directly) and uses SQL only for synthetic seed (one throwaway non-admin user + a throwaway
// role granting it tasks:read/tasks:write) and stamped cleanup — same discipline as the
// sibling ae4/rd45/mp6/hmr5 staging smokes (staging-attendance-*-smoke.mjs).
//
// Grounding (all on origin/main):
//   packages/core-backend/src/routes/tasks.ts:36 `if (process.env.TASKS_ENABLED !== 'true')
//     return null` — the feature flag gate this smoke's TASKS_ENABLED preflight proves is live.
//   packages/core-backend/src/rbac/rbac.ts rbacGuard('tasks','read'|'write') — checks BOTH a
//     resolved tasks:read/write permission (role_permissions + user_roles) AND
//     isPermissionAllowedByNamespaceAdmission (user_namespace_admissions, namespace='tasks').
//     Missing EITHER is 403 — this smoke proves the role-only state is insufficient (403)
//     before granting the admission row, then proves the granted state is sufficient (200s).
//   packages/core-backend/src/auth/AuthService.ts verifyToken -> resolveSessionTenantId: the
//     ONLY thing that sets req.authenticatedTenantId (which tasks.ts's orgId() reads) is a
//     JWT `tenantId` claim resolved against an ACTIVE user_orgs row — never the x-org-id
//     header other smokes rely on. The window-runner mints this smoke's SUBJECT_TOKEN with
//     --tenant-id (see mint_token's comment in attendance-staging-window-runner-remote.sh).
//   packages/core-backend/src/services/task-records.ts createTask/completeTask/reopenTask —
//     response shapes {id}/{done}/{ok:true}; POST /api/tasks with no `assignees` field defaults
//     to [creatorId] (resolveCreateAssigneeIds), so this smoke's single subject is both the
//     creator AND the sole assignee of every task it creates — completionMode defaults to
//     'all', so /complete with one assignee (itself) transitions the task straight to done.
//   Seed SQL shape (users/roles/role_permissions/user_roles/user_namespace_admissions columns
//     and FK-safe cleanup order) mirrors the real-DB gate fixtures
//     packages/core-backend/tests/tasks-auth/tasks-auth-gate.ts and
//     packages/core-backend/tests/integration/task-rbac-trust.db.test.ts.
//
// Org choice: `default` — the SAME deterministic org every other window smoke already defaults
// ORG_ID to (ae4/rd45/otbank-v18/mp6/hmr5), so this smoke introduces no new org concept.
//
// Cases (one throwaway non-admin subject; org 'default'):
//   preflight: P0-A tables + tasks:read/tasks:write permission catalog rows exist (to_regclass
//              + a permissions-table count), and no pre-existing residue for this stamp.
//   seed:      users + user_orgs + roles + role_permissions + user_roles (NOT the admission row
//              yet — the negative check below needs the "role granted, admission missing" state).
//   negative:  GET /api/tasks/context -> exactly 403 (role_permissions+user_roles alone, without
//              a user_namespace_admissions row, must NOT be enough — rbac.ts's namespace-
//              admission AND gate). 401 = an auth/tenant seed bug in THIS smoke, not the gate
//              under test; 404 = TASKS_ENABLED is not actually live (the bash-side pre-check
//              should already have caught this, but the smoke also refuses to misread it).
//   admission: grant user_namespace_admissions(user_id, 'tasks', enabled=true).
//   positive:  GET /api/tasks/context -> 200 non-null orgId; POST /api/tasks -> 200 {id};
//              GET /api/tasks?view=created contains it; POST .../complete -> 200 {done:true};
//              POST .../reopen {scope:'self'} -> 200 {ok:true}; GET /api/tasks/:id -> 200 full
//              detail.
//   residue:   FK-safe teardown (tasks by created_by, cascading task_assignees/task_followers/
//              task_events; user_namespace_admissions; user_roles; user_orgs; users;
//              role_permissions; roles) — ALWAYS attempted (try/catch/finally), residue re-
//              proven zero, and a cleanup failure is reported as its own failure rather than
//              silently folded into (or hidden behind) the HTTP-assertion verdict.

import { pathToFileURL } from 'node:url'

// --- pure helpers (exported for the companion .test.mjs) -----------------------------------

export const STAMP_PATTERN = /^tasks-smoke-[A-Za-z0-9-]+$/

export function isStampedId(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length
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

// The one hard safety invariant the owner named explicitly: this throwaway role must never be
// mistaken for a delegated-admin role. namespace-admission.ts's deriveDelegatedAdminNamespace
// treats any role id ending "_admin" (other than the literal "admin") as granting IMPLICIT
// namespace control — exactly the escalation this smoke's role must NOT have. Asserted
// programmatically (not just by naming convention) so a future edit cannot silently violate it.
export function assertNotAdminRoleId(roleId) {
  if (roleId.endsWith('_admin')) {
    throw new Error(`refusing to use a role id ending "_admin" for a non-admin smoke subject: ${roleId}`)
  }
  return roleId
}

// Env-only contract (no CLI args), mirroring the OT-bank v1-8 / mp6 / hmr5 helpers: BASE_URL/
// DATABASE_URL required, DEPLOY_SHA mandatory (the PASS stamp must name the staging build
// actually smoked), STAMP regex-locked so cleanup stays visibly synthetic and LIKE-free.
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
  console.error('  e.g. BASE_URL=http://127.0.0.1:8082 DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet DEPLOY_SHA=<deployed-sha> SUBJECT_TOKEN=<jwt> node scripts/ops/staging-tasks-smoke.mjs')
  process.exit(2)
}

const { baseUrl: BASE_URL, databaseUrl: DATABASE_URL, orgId: ORG_ID, deploySha: DEPLOY_SHA, stamp: STAMP } = ENTRY.config
// The subject IS the stamp itself (owner-named literally: "create a namespaced throwaway
// non-admin user tasks-smoke-<RUN_STAMP>") — one subject, not a family, so no extra suffix.
const USER_ID = STAMP
const ROLE_ID = assertNotAdminRoleId(`${STAMP}-role`)

let subjectToken = process.env.SUBJECT_TOKEN || ''
let cleanupAllowed = false
let pass = 0
const failures = []
const created = { taskIds: [] }

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

async function mintToken(userId) {
  const res = await api('', `/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=user&perms=tasks:read,tasks:write&tenantId=${encodeURIComponent(ORG_ID)}`)
  const token = res.body?.token || ''
  if (!token) {
    throw new Error(`could not mint dev-token for ${userId} (status ${res.status}); provide an explicit SUBJECT_TOKEN for staging environments that 404 the dev-token route (production node-env)`)
  }
  return token
}

async function resolveSubjectToken() {
  if (subjectToken) {
    const subject = jwtSubject(subjectToken)
    if (subject !== USER_ID) {
      throw new Error(`SUBJECT_TOKEN subject "${subject}" does not equal subject user id "${USER_ID}"`)
    }
    console.log(`  using supplied subject token (subject ${subject})`)
  } else {
    subjectToken = await mintToken(USER_ID)
    console.log('  minted subject dev-token')
  }
}

// --- preflight ---------------------------------------------------------------------------

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
       to_regclass('public.task_events') IS NOT NULL AS task_events_ok`,
  ))[0] || {}
  const tablesReady = Object.values(row).every((value) => value === true)
  ok(tablesReady, 'DB assertion channel reachable and P0-A task tables exist', row)
  if (!tablesReady) throw new Error('staging DB is missing P0-A task tables (or RBAC tables), or DATABASE_URL points at the wrong database — the tasks migration may not be applied yet')

  const permRow = (await q(
    `SELECT count(*)::int AS n FROM permissions WHERE code IN ('tasks:read', 'tasks:write')`,
  ))[0] || {}
  const permsReady = Number(permRow.n) === 2
  ok(permsReady, 'permission catalog carries tasks:read and tasks:write (role_permissions FK precondition)', permRow)
  if (!permsReady) throw new Error('permissions table is missing tasks:read/tasks:write — role_permissions insert would fail its FK (23503), not 403')
}

async function preflightNoExistingResidue() {
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM users WHERE id = $1) AS users,
       (SELECT count(*)::int FROM user_orgs WHERE user_id = $1) AS user_orgs,
       (SELECT count(*)::int FROM user_roles WHERE user_id = $1) AS user_roles,
       (SELECT count(*)::int FROM user_namespace_admissions WHERE user_id = $1) AS admissions,
       (SELECT count(*)::int FROM roles WHERE id = $2) AS roles,
       (SELECT count(*)::int FROM role_permissions WHERE role_id = $2) AS role_permissions,
       (SELECT count(*)::int FROM tasks WHERE created_by = $1) AS tasks`,
    [USER_ID, ROLE_ID],
  ))[0] || {}
  const clean = Object.values(row).every((value) => Number(value) === 0)
  ok(clean, 'no pre-existing residue for this tasks-smoke stamp', row)
  if (!clean) throw new Error(`pre-existing residue found for ${STAMP}; use a fresh STAMP or inspect before running`)
}

// --- seed (role granted, admission NOT yet granted) ---------------------------------------

async function seedRoleAndUser() {
  assertNotAdminRoleId(ROLE_ID)
  if (!isStampedId(USER_ID, 'tasks-smoke-')) {
    throw new Error(`refusing to run: subject "${USER_ID}" is not stamped tasks-smoke-. This smoke deletes its synthetic user during cleanup.`)
  }
  await pool.query('INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [ROLE_ID, ROLE_ID])
  await pool.query(
    `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read'), ($1, 'tasks:write')
     ON CONFLICT DO NOTHING`,
    [ROLE_ID],
  )
  await pool.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, activation_status, local_password_set, must_change_password
     )
     VALUES ($1, $2, $3, 'no-login', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE)
     ON CONFLICT (id) DO UPDATE SET is_active = true, email = EXCLUDED.email, name = EXCLUDED.name`,
    [USER_ID, `${USER_ID}@example.test`, USER_ID],
  )
  await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [USER_ID, ROLE_ID])
  await pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
    [USER_ID, ORG_ID],
  )
  cleanupAllowed = true
  ok(true, 'seeded synthetic non-admin subject: users + user_orgs + roles + role_permissions(tasks:read,tasks:write) + user_roles', { stamp: STAMP, role: ROLE_ID })
}

async function grantAdmission() {
  await pool.query(
    `INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source, granted_by, updated_by, created_at, updated_at)
     VALUES ($1, 'tasks', TRUE, 'staging_window_runner_smoke', $1, $1, now(), now())
     ON CONFLICT (user_id, namespace) DO UPDATE SET enabled = TRUE, updated_at = now()`,
    [USER_ID],
  )
  ok(true, 'granted user_namespace_admissions(tasks, enabled=true)', { user: USER_ID })
}

// --- HTTP checks -----------------------------------------------------------------------------

async function checkNamespaceAdmissionGate() {
  const res = await api(subjectToken, '/api/tasks/context')
  if (res.status === 404) {
    throw new Error('GET /api/tasks/context -> 404: TASKS_ENABLED is not actually live on the running backend (tasksRouter() returned null) — the bash-side pre-check should have refused before this smoke even ran')
  }
  if (res.status === 401) {
    throw new Error(`GET /api/tasks/context -> 401: this smoke's own auth/tenant seed is wrong (not the namespace-admission gate under test) — body: ${JSON.stringify(res.body)}`)
  }
  ok(res.status === 403, 'GET /api/tasks/context is 403 BEFORE the namespace admission row exists (role_permissions+user_roles alone must be insufficient)', res.body)
  if (res.status !== 403) {
    throw new Error(`SECURITY: expected 403 without a user_namespace_admissions row, got ${res.status} — the namespace-admission AND gate did not hold`)
  }
}

async function checkContext() {
  const res = await api(subjectToken, '/api/tasks/context')
  ok(res.status === 200, `GET /api/tasks/context -> 200 (status ${res.status})`, res.body)
  ok(res.body?.orgId === ORG_ID, `context orgId resolves to the tenant claim (${ORG_ID})`, res.body)
}

async function createOneTask() {
  const res = await api(subjectToken, '/api/tasks', { method: 'POST', body: { title: STAMP } })
  ok(res.status === 200, `POST /api/tasks -> 200 (status ${res.status})`, res.body)
  const id = res.body?.id
  ok(typeof id === 'string' && id.length > 0, 'created task carries an id', res.body)
  if (typeof id !== 'string' || id.length === 0) throw new Error(`POST /api/tasks did not return an id: ${JSON.stringify(res.body)}`)
  created.taskIds.push(id)
  return id
}

async function checkListedInCreatedView(taskId) {
  const res = await api(subjectToken, '/api/tasks?view=created')
  ok(res.status === 200, `GET /api/tasks?view=created -> 200 (status ${res.status})`, res.body)
  const ids = Array.isArray(res.body?.items) ? res.body.items.map((row) => row.id) : []
  ok(ids.includes(taskId), 'created task is visible under view=created', { taskId, ids })
}

async function completeThenReopen(taskId) {
  const complete = await api(subjectToken, `/api/tasks/${encodeURIComponent(taskId)}/complete`, { method: 'POST' })
  ok(complete.status === 200, `POST /api/tasks/:id/complete -> 200 (status ${complete.status})`, complete.body)
  ok(complete.body?.done === true, 'complete transitions the single-assignee task to done', complete.body)

  const reopen = await api(subjectToken, `/api/tasks/${encodeURIComponent(taskId)}/reopen`, { method: 'POST', body: { scope: 'self' } })
  ok(reopen.status === 200, `POST /api/tasks/:id/reopen {scope:'self'} -> 200 (status ${reopen.status})`, reopen.body)
  ok(reopen.body?.ok === true, 'reopen acknowledges', reopen.body)
}

async function checkFullRead(taskId) {
  const res = await api(subjectToken, `/api/tasks/${encodeURIComponent(taskId)}`)
  ok(res.status === 200, `GET /api/tasks/:id -> 200 (status ${res.status})`, res.body)
  ok(res.body?.id === taskId, 'read-back id matches the created task', res.body)
}

// --- cleanup + residue -----------------------------------------------------------------------

async function cleanup() {
  if (!cleanupAllowed) return
  const taskIds = created.taskIds
  // FK-safe order (mirrors tasks-auth-gate.ts / task-rbac-trust.db.test.ts, the real-DB gate
  // fixtures this seed shape is copied from): task children explicitly (task_assignees/
  // task_followers/task_events also cascade off `tasks` via ON DELETE CASCADE — explicit
  // deletes here are defensive, not load-bearing), then tasks, then admission, roles-of-user,
  // org membership, the user row itself, and finally the role/permission grant rows.
  if (taskIds.length > 0) {
    await pool.query('DELETE FROM task_events WHERE task_id = ANY($1::text[])', [taskIds]).catch(() => undefined)
    await pool.query('DELETE FROM task_assignees WHERE task_id = ANY($1::text[])', [taskIds]).catch(() => undefined)
    await pool.query('DELETE FROM task_followers WHERE task_id = ANY($1::text[])', [taskIds]).catch(() => undefined)
  }
  await pool.query('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE created_by = $1)', [USER_ID]).catch(() => undefined)
  await pool.query('DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE created_by = $1)', [USER_ID]).catch(() => undefined)
  await pool.query('DELETE FROM task_followers WHERE task_id IN (SELECT id FROM tasks WHERE created_by = $1)', [USER_ID]).catch(() => undefined)
  await pool.query('DELETE FROM tasks WHERE created_by = $1', [USER_ID]).catch(() => undefined)
  // ALL admission/role rows for this user (not scoped to the 'tasks' namespace or to ROLE_ID
  // alone): AuthService.resolveRbacProfile may have silently backfilled an unrelated
  // attendance_employee user_roles row on first token verify (shouldBackfillAttendanceSelfService),
  // so cleanup must not assume the only user_roles row is the one this script itself inserted.
  await pool.query('DELETE FROM user_namespace_admissions WHERE user_id = $1', [USER_ID]).catch(() => undefined)
  await pool.query('DELETE FROM user_roles WHERE user_id = $1', [USER_ID]).catch(() => undefined)
  await pool.query('DELETE FROM user_orgs WHERE user_id = $1', [USER_ID]).catch(() => undefined)
  await pool.query('DELETE FROM users WHERE id = $1', [USER_ID]).catch(() => undefined)
  await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [ROLE_ID]).catch(() => undefined)
  await pool.query('DELETE FROM roles WHERE id = $1', [ROLE_ID]).catch(() => undefined)
}

async function residueCounts() {
  const row = (await q(
    `SELECT
       (SELECT count(*)::int FROM users WHERE id = $1) AS users,
       (SELECT count(*)::int FROM user_orgs WHERE user_id = $1) AS user_orgs,
       (SELECT count(*)::int FROM user_roles WHERE user_id = $1) AS user_roles,
       (SELECT count(*)::int FROM user_namespace_admissions WHERE user_id = $1) AS admissions,
       (SELECT count(*)::int FROM roles WHERE id = $2) AS roles,
       (SELECT count(*)::int FROM role_permissions WHERE role_id = $2) AS role_permissions,
       (SELECT count(*)::int FROM tasks WHERE created_by = $1) AS tasks,
       (SELECT count(*)::int FROM task_assignees WHERE user_id = $1) AS task_assignees,
       (SELECT count(*)::int FROM task_followers WHERE user_id = $1) AS task_followers`,
    [USER_ID, ROLE_ID],
  ))[0] || {}
  return row
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  console.log(`tasks (P0-A) API/DB staging smoke helper @ ${BASE_URL}`)
  console.log(`  deploy=${DEPLOY_SHA} org=${ORG_ID} stamp=${STAMP} subject=${USER_ID} role=${ROLE_ID}`)

  await preflightDatabase()
  await preflightNoExistingResidue()
  await seedRoleAndUser()
  await resolveSubjectToken()

  await checkNamespaceAdmissionGate()
  await grantAdmission()

  await checkContext()
  const taskId = await createOneTask()
  await checkListedInCreatedView(taskId)
  await completeThenReopen(taskId)
  await checkFullRead(taskId)

  await cleanup()
  const residue = await residueCounts()
  const residueOk = Object.values(residue).every((value) => Number(value) === 0)
  ok(residueOk, 'cleanup residue is zero across every touched table', residue)
  if (!residueOk) throw new Error(`residue not zero: ${JSON.stringify(residue)}`)
  if (failures.length) {
    throw new Error(`tasks API/DB smoke had ${failures.length} failed assertion(s): ${failures.join('; ')}`)
  }

  console.log(`TASKS_API_DB_SMOKE_PASS deploy=${DEPLOY_SHA} stamp=${STAMP} org=${ORG_ID} task=${taskId} residue=0`)
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
      // Cleanup failure must be reported as ITS OWN failure, never silently folded into (or
      // hidden behind) the HTTP-assertion verdict above — the run's overall nonzero exit
      // already reflects the primary failure; this block only adds cleanup's own status.
      try {
        await cleanup()
        const residue = await residueCounts()
        const residueOk = Object.values(residue).every((value) => Number(value) === 0)
        console.error(`Residue after best-effort cleanup: ${JSON.stringify(residue)} (clean=${residueOk})`)
      } catch (cleanupError) {
        console.error(`FAIL: best-effort cleanup itself failed: ${cleanupError?.message || cleanupError}`)
      }
      process.exitCode = 1
    })
    .finally(async () => {
      await pool.end().catch(() => undefined)
    })
}
