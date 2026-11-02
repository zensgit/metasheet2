import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { getBcryptSaltRounds } from '../../src/security/auth-runtime-config'
import { dropTaskM4Fixtures } from '../helpers/task-m4-fixtures'

/**
 * The enablement page (docs/deployment/tasks-enablement.md), followed over real HTTP against the
 * real server (MetaSheetServer, started in this process on 127.0.0.1) and this lane's temporary
 * database. The cells run in the order an administrator works through the page, and each one
 * builds on the one before it.
 *
 * Page step -> cell:
 *   step 1 check (`/api/auth/me`, `data.features.tasks`)   -> 'step 1 check'
 *   before step 2: an employee is refused                    -> 'before step 2'
 *   step 2 (POST /api/roles)                                 -> 'step 2'
 *   step 3 (POST /api/admin/users/:id/roles/assign)          -> 'step 3'
 *   step 4 (PATCH .../namespaces/tasks/admission, and bulk)  -> 'step 4'
 *   acceptance 1-2 (the employee opens tasks, creates one)   -> 'acceptance 1-2'
 *   acceptance 3 (naming another enabled employee)           -> 'acceptance 3'
 *   FAQ: role but no step 4 / no role at all                 -> the two 'refused' cells
 *   FAQ: removing the role, then assigning it again          -> the two 'FAQ' cells
 *
 * Fixture, by SQL: five `users` rows (one platform administrator by `users.role`, four employees)
 * with a password hashed by the backend's own bcrypt settings, one active `user_orgs` row each in
 * one org, and the columns sign-in reads (active, activated, local password set). Nothing else.
 * Every role, permission and task access row is written by the page's own HTTP calls, every token
 * comes from POST /api/auth/login (one sign-in per account, under the per-account limit), and the
 * positive case is an employee, never the administrator.
 *
 * Token-claim trust is off: this file runs only under vitest.tasks-enablement.config.ts, its own
 * step in tasks-realdb.yml, which does not load tests/setup.integration.ts. The sign-in token
 * carries no role or permission claims either (asserted), so every answer below comes from the
 * database. The product mode is the default one.
 *
 * Permission memo: an employee's 403 before the grant is read while the memo is cold, and the
 * same token is used after the grant, without signing in again. One server process here.
 *
 * NOT covered: the admin pages (/admin/roles, /admin/users), loading `app.env` and restarting the
 * backend, the PM2 / systemd / Docker / Windows steps, more than one backend process, and any real
 * deployment. The switch is on for the whole file; the off state is not exercised.
 *
 * Every id starts with this file's prefixes. `tasks_member` is a global role id: the file removes
 * it before and after the run, and refuses to start if accounts it did not create hold it.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-enablement-http.db.test.ts requires EXPECT_DB=1')
}
if (process.env.TASKS_ENABLEMENT_SETUP !== '1' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('task-enablement-http.db.test.ts runs only under vitest.tasks-enablement.config.ts')
}

const USER_PREFIX = 'usr_tenable_'
const ORG_PREFIX = 'org_tenable_'
const ROLE_ID = 'tasks_member'
const TASK_CODES = ['tasks:read', 'tasks:write']

const stamp = randomUUID().replace(/-/g, '').slice(0, 12)
const orgId = `${ORG_PREFIX}${stamp}`
const password = `Pw-${randomUUID()}`

/** `full_a` and `full_b` get steps 3 and 4, `role_only` gets step 3 only, `no_role` gets nothing. */
const PEOPLE = ['admin', 'full_a', 'full_b', 'role_only', 'no_role'] as const
type Person = typeof PEOPLE[number]
const uid: Record<Person, string> = Object.fromEntries(
  PEOPLE.map((person) => [person, `${USER_PREFIX}${person}_${stamp}`]),
) as Record<Person, string>
const tokens = {} as Record<Person, string>

const REFUSED = { error: { code: 'ASSIGNEE_TASK_ACCESS_REQUIRED' } }
const FORBIDDEN = { error: 'Insufficient permissions' }

const pool = () => poolManager.get()
let server: MetaSheetServer | undefined
let baseUrl = ''

type Reply = { status: number; json: any; text: string }

function emailOf(userId: string): string {
  return `${userId}@tasks-enablement.test`
}

async function call(method: string, path: string, bearer?: string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json: unknown
  try { json = text.length > 0 ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: response.status, json, text }
}

async function seedUser(userId: string, role: 'admin' | 'user', hash: string): Promise<void> {
  await pool().query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, activation_status, local_password_set, must_change_password
     ) VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, TRUE, 'activated', TRUE, FALSE)`,
    [userId, emailOf(userId), userId, hash, role],
  )
  await pool().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [userId, orgId])
}

/** Removes every row this file's prefixes reach, from this run or an earlier one. */
async function sweepPrefixed(): Promise<void> {
  const leftover = await pool().query(`SELECT id FROM users WHERE left(id, length($1)) = $1`, [USER_PREFIX])
  const userIds = leftover.rows.map((row) => String(row.id))
  if (userIds.length > 0) await pool().query('DELETE FROM user_sessions WHERE user_id = ANY($1::text[])', [userIds])
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds })
}

/** Drops `tasks_member` when nobody holds it any more; false when some other account still does. */
async function dropRoleIfUnheld(): Promise<boolean> {
  const holders = await pool().query('SELECT 1 FROM user_roles WHERE role_id = $1 LIMIT 1', [ROLE_ID])
  if (holders.rows.length > 0) return false
  await pool().query('DELETE FROM role_permissions WHERE role_id = $1', [ROLE_ID])
  await pool().query('DELETE FROM roles WHERE id = $1', [ROLE_ID])
  return true
}

/** The person's task access row as step 4 writes it, or null when there is none. */
async function taskAccessRow(userId: string): Promise<{ enabled: boolean } | null> {
  const result = await pool().query(
    `SELECT enabled FROM user_namespace_admissions WHERE user_id = $1 AND namespace = 'tasks'`,
    [userId],
  )
  const row = result.rows[0]
  return row ? { enabled: row.enabled === true } : null
}

/** Every task row of the org with its assignee, event and delivery rows, for "nothing was written". */
async function orgState(): Promise<string> {
  const tasks = await pool().query('SELECT id, status, version FROM tasks WHERE org_id = $1 ORDER BY id', [orgId])
  const assignees = await pool().query(
    `SELECT a.task_id, a.user_id FROM task_assignees a JOIN tasks t ON t.id = a.task_id
     WHERE t.org_id = $1 ORDER BY a.task_id, a.user_id`,
    [orgId],
  )
  const events = await pool().query(
    `SELECT e.id, e.event_type FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.org_id = $1 ORDER BY e.id`,
    [orgId],
  )
  const deliveries = await pool().query('SELECT id FROM task_notification_deliveries WHERE org_id = $1 ORDER BY id', [orgId])
  return JSON.stringify({ tasks: tasks.rows, assignees: assignees.rows, events: events.rows, deliveries: deliveries.rows })
}

/** Member ids in byte order (`COLLATE "C"`, the order of JS's default sort). */
async function memberIds(taskId: string): Promise<string[]> {
  const result = await pool().query(`SELECT user_id FROM task_assignees WHERE task_id = $1 ORDER BY user_id COLLATE "C"`, [taskId])
  return result.rows.map((row) => String(row.user_id))
}

async function context(person: Person): Promise<Reply> {
  return call('GET', '/api/tasks/context', tokens[person])
}

async function createTaskAs(person: Person, assignees: string[]): Promise<Reply> {
  return call('POST', '/api/tasks', tokens[person], { title: '备料复核', assignees })
}

async function addAssigneeAs(person: Person, taskId: string, userId: string): Promise<Reply> {
  return call('POST', `/api/tasks/${taskId}/assignees`, tokens[person], { userId })
}

beforeAll(async () => {
  await sweepPrefixed()
  if (!await dropRoleIfUnheld()) {
    throw new Error(`role ${ROLE_ID} is held by accounts this file did not create; refusing to run`)
  }
  const hash = await bcrypt.hash(password, getBcryptSaltRounds())
  for (const person of PEOPLE) await seedUser(uid[person], person === 'admin' ? 'admin' : 'user', hash)

  server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  await server.start()
  const address = server.getAddress()
  const port = address && typeof address === 'object' ? address.port : undefined
  expect(port).toBeTruthy()
  baseUrl = `http://127.0.0.1:${port}`
}, 120000)

afterAll(async () => {
  try {
    await sweepPrefixed()
    await dropRoleIfUnheld()
  } finally {
    await server?.stop()
  }
}, 60000)

describe('the enablement page, step by step, over HTTP', () => {
  it('sign-in: every account signs in through POST /api/auth/login; the token carries no role or permission claims', async () => {
    for (const person of PEOPLE) {
      const response = await call('POST', '/api/auth/login', undefined, { email: emailOf(uid[person]), password })
      expect(response.status, `${person} ${response.text}`).toBe(200)
      const token = response.json?.data?.token
      expect(typeof token, person).toBe('string')
      const claims = jwt.decode(token) as Record<string, unknown>
      expect(claims.userId, person).toBe(uid[person])
      expect(claims.tenantId, person).toBe(orgId)
      for (const key of ['roles', 'perms', 'permissions']) expect(Object.keys(claims), `${person} ${key}`).not.toContain(key)
      tokens[person] = token
    }
  })

  it('step 1 check: GET /api/auth/me answers data.features.tasks true, for the administrator and for an employee with nothing granted', async () => {
    for (const person of ['admin', 'full_a', 'no_role'] as const) {
      const me = await call('GET', '/api/auth/me', tokens[person])
      expect(me.status, `${person} ${me.text}`).toBe(200)
      expect(me.json?.data?.features?.tasks, person).toBe(true)
    }
    // The flag says the switch is on; it says nothing about this person, who has no task codes yet.
    const me = await call('GET', '/api/auth/me', tokens.full_a)
    expect(me.json?.data?.user?.permissions ?? []).not.toContain('tasks:read')
  })

  it('before step 2: an employee is 403 on GET /api/tasks/context and on POST /api/tasks; the administrator is 200', async () => {
    const refused = await context('full_a')
    expect(refused.status, refused.text).toBe(403)
    expect(refused.json).toEqual(FORBIDDEN)
    const write = await createTaskAs('full_a', [])
    expect(write.status, write.text).toBe(403)
    const admin = await context('admin')
    expect(admin.status, admin.text).toBe(200)
    expect(admin.json).toEqual({ orgId })
  })

  it('step 2: POST /api/roles creates tasks_member with exactly the two task codes', async () => {
    const response = await call('POST', '/api/roles', tokens.admin, { id: ROLE_ID, name: '任务成员', permissions: TASK_CODES })
    expect(response.status, response.text).toBe(200)
    expect(response.json?.ok).toBe(true)
    expect(response.json?.data?.id).toBe(ROLE_ID)
    const codes = await pool().query('SELECT permission_code FROM role_permissions WHERE role_id = $1', [ROLE_ID])
    expect(codes.rows.map((row) => String(row.permission_code)).sort()).toEqual(TASK_CODES)
  })

  it('step 3: POST /api/admin/users/:id/roles/assign gives three employees the role; the role alone does not open tasks', async () => {
    for (const person of ['full_a', 'full_b', 'role_only'] as const) {
      const response = await call('POST', `/api/admin/users/${uid[person]}/roles/assign`, tokens.admin, { roleId: ROLE_ID })
      expect(response.status, `${person} ${response.text}`).toBe(200)
      expect(response.json?.data?.roleHeld, person).toBe(true)
    }
    const refused = await context('full_a')
    expect(refused.status, refused.text).toBe(403)
    expect(await taskAccessRow(uid.full_a)).toBeNull()
  })

  it('step 4: PATCH .../namespaces/tasks/admission enables one employee, the bulk call another; the third keeps the role only', async () => {
    const single = await call('PATCH', `/api/admin/users/${uid.full_a}/namespaces/tasks/admission`, tokens.admin, { enabled: true })
    expect(single.status, single.text).toBe(200)
    const entry = (single.json?.data?.namespaceAdmissions as Array<Record<string, unknown>> | undefined)
      ?.find((item) => item.namespace === 'tasks')
    // The page's check: role held, task access enabled, usable now.
    expect(entry).toMatchObject({ namespace: 'tasks', hasRole: true, enabled: true, effective: true })

    const bulk = await call('POST', '/api/admin/users/namespaces/tasks/admission/bulk', tokens.admin, {
      userIds: [uid.full_b],
      enabled: true,
    })
    expect(bulk.status, bulk.text).toBe(200)
    expect(bulk.json?.data?.updatedCount).toBe(1)

    expect(await taskAccessRow(uid.full_a)).toMatchObject({ enabled: true })
    expect(await taskAccessRow(uid.full_b)).toMatchObject({ enabled: true })
    expect(await taskAccessRow(uid.role_only)).toBeNull()
  })

  it('acceptance 1-2: the employee opens tasks with the token from before the grant, and creates a task', async () => {
    const opened = await context('full_a')
    expect(opened.status, opened.text).toBe(200)
    expect(opened.json).toEqual({ orgId })
    const me = await call('GET', '/api/auth/me', tokens.full_a)
    expect(me.json?.data?.user?.permissions).toEqual(expect.arrayContaining(TASK_CODES))

    const created = await createTaskAs('full_a', [uid.full_a])
    expect(created.status, created.text).toBe(200)
    expect(await memberIds(String(created.json?.id))).toEqual([uid.full_a])
  })

  it('acceptance 3: naming another enabled employee succeeds when creating a task and when adding an assignee', async () => {
    const both = await createTaskAs('full_a', [uid.full_a, uid.full_b])
    expect(both.status, both.text).toBe(200)
    const bothId = String(both.json?.id)
    expect(await memberIds(bothId)).toEqual([uid.full_a, uid.full_b].sort())

    const mine = await createTaskAs('full_a', [uid.full_a])
    expect(mine.status, mine.text).toBe(200)
    const mineId = String(mine.json?.id)
    const added = await addAssigneeAs('full_a', mineId, uid.full_b)
    expect(added.status, added.text).toBe(200)
    expect(await memberIds(mineId)).toEqual([uid.full_a, uid.full_b].sort())

    // The person named reaches the task, with the token from before the bulk call.
    const detail = await call('GET', `/api/tasks/${bothId}`, tokens.full_b)
    expect(detail.status, detail.text).toBe(200)
  })

  it('refused: an assignee with the role but without step 4 is 422 ASSIGNEE_TASK_ACCESS_REQUIRED when creating and when adding; nothing is written', async () => {
    const mine = await createTaskAs('full_a', [uid.full_a])
    expect(mine.status, mine.text).toBe(200)
    const mineId = String(mine.json?.id)

    let before = await orgState()
    const create = await createTaskAs('full_a', [uid.full_a, uid.role_only])
    expect(create.status, create.text).toBe(422)
    expect(create.json).toEqual(REFUSED)
    expect(await orgState()).toBe(before)

    before = await orgState()
    const add = await addAssigneeAs('full_a', mineId, uid.role_only)
    expect(add.status, add.text).toBe(422)
    expect(add.json).toEqual(REFUSED)
    expect(await orgState()).toBe(before)

    const own = await context('role_only')
    expect(own.status, own.text).toBe(403)
  })

  it('refused: an employee with no role is 403 on the task routes and 422 as an assignee; nothing is written', async () => {
    const own = await context('no_role')
    expect(own.status, own.text).toBe(403)
    expect(own.json).toEqual(FORBIDDEN)

    const before = await orgState()
    const create = await createTaskAs('full_a', [uid.full_a, uid.no_role])
    expect(create.status, create.text).toBe(422)
    expect(create.json).toEqual(REFUSED)
    expect(await orgState()).toBe(before)
  })

  it('FAQ: removing the role turns task access off', async () => {
    const removed = await call('POST', `/api/admin/users/${uid.full_a}/roles/unassign`, tokens.admin, { roleId: ROLE_ID })
    expect(removed.status, removed.text).toBe(200)
    expect(removed.json?.data?.roleHeld).toBe(false)
    expect(await taskAccessRow(uid.full_a)).toMatchObject({ enabled: false })

    const own = await context('full_a')
    expect(own.status, own.text).toBe(403)

    // Nobody can name that person any more.
    const task = await createTaskAs('full_b', [uid.full_b])
    expect(task.status, task.text).toBe(200)
    const before = await orgState()
    const add = await addAssigneeAs('full_b', String(task.json?.id), uid.full_a)
    expect(add.status, add.text).toBe(422)
    expect(add.json).toEqual(REFUSED)
    expect(await orgState()).toBe(before)
  })

  it('FAQ: assigning the role again does not turn task access back on; step 4 again does', async () => {
    const again = await call('POST', `/api/admin/users/${uid.full_a}/roles/assign`, tokens.admin, { roleId: ROLE_ID })
    expect(again.status, again.text).toBe(200)
    expect(again.json?.data?.roleHeld).toBe(true)
    expect(await taskAccessRow(uid.full_a)).toMatchObject({ enabled: false })
    const still = await context('full_a')
    expect(still.status, still.text).toBe(403)

    const step4 = await call('PATCH', `/api/admin/users/${uid.full_a}/namespaces/tasks/admission`, tokens.admin, { enabled: true })
    expect(step4.status, step4.text).toBe(200)
    const opened = await context('full_a')
    expect(opened.status, opened.text).toBe(200)
  })
})
