import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import type express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { pendingSourceRegistry } from '../../src/services/pending-source-registry'
import { completeTask, createTask } from '../../src/services/task-records'
import {
  dropTaskM4Fixtures,
  seedOrgMembers,
  seedTaskActor,
  signTaskToken,
  type SeededTaskActor,
} from '../helpers/task-m4-fixtures'

/**
 * The todo center's task source under the production wiring: the file boots `MetaSheetServer` and
 * registers nothing by hand. Token roles carry no permission list, so access is decided by the
 * database lookups. Test names start with `todo-source|`.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-todo-source.db.test.ts requires EXPECT_DB=1')
}
if (process.env.TASKS_ENABLED !== 'true') {
  throw new Error('task-todo-source.db.test.ts requires TASKS_ENABLED=true')
}

const ORG_PREFIX = 'org_tasks_todosrc_'
const stamp = randomUUID().replace(/-/g, '').slice(0, 12)
const ORG_A = `${ORG_PREFIX}a_${stamp}`
const ORG_B = `${ORG_PREFIX}b_${stamp}`
const ITEMS = '/api/todo/items'
const COUNT = '/api/todo/count'
const BADGE = '/api/tasks/pending-count'
const FORBIDDEN_BODY = '{"error":"Insufficient permissions"}'
const APPROVAL_NODE = 'approval_a'

const seededUsers: string[] = []
const seededRoles: string[] = []
const seededInstances: string[] = []

const creatorId = `usr_creator_${stamp}`
const otherId = `usr_other_${stamp}`

let app: express.Express

function db() {
  return poolManager.get()
}

async function actor(label: string, codes: string[], taskAccess: boolean, orgId = ORG_A): Promise<SeededTaskActor> {
  const seeded = await seedTaskActor({ label, stamp, orgId, codes, admission: taskAccess })
  seededUsers.push(seeded.userId)
  seededRoles.push(seeded.roleId)
  return seeded
}

function get(path: string, bearer: string) {
  return request(app).get(path).set('Authorization', `Bearer ${bearer}`)
}

async function assignedTask(assignees: string[], extra: Record<string, unknown> = {}, orgId = ORG_A): Promise<string> {
  const created = await createTask({
    orgId,
    creatorId,
    title: `todo source ${randomUUID()}`,
    assignees,
    completionMode: 'all',
    ...extra,
  })
  return created.id
}

/** A pending approval instance on which `userId` holds a user seat. */
async function approvalSeat(userId: string): Promise<string> {
  const id = `todosrc-${randomUUID()}`
  seededInstances.push(id)
  await db().query(
    `INSERT INTO approval_instances (id, status, source_system, published_definition_id, current_node_key, org_id)
     VALUES ($1, 'pending', 'platform', NULL, $2, $3)`,
    [id, APPROVAL_NODE, ORG_A],
  )
  await db().query(
    `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, is_active)
     VALUES ($1, 'user', $2, $3, TRUE)`,
    [id, userId, APPROVAL_NODE],
  )
  return id
}

function nextWeek(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function ids(body: { items: Array<{ id: string }> }): string[] {
  return body.items.map((item) => item.id).sort()
}

beforeAll(async () => {
  await db().query(
    `INSERT INTO permissions (code, name, description)
     VALUES ('approvals:read', 'Approvals Read', 'read')
     ON CONFLICT (code) DO NOTHING`,
  )
  await seedOrgMembers(ORG_A, [creatorId, otherId])
  seededUsers.push(creatorId, otherId)
  const server = new MetaSheetServer({
    port: 0,
    host: '127.0.0.1',
    pluginDirs: [],
    manageProcessSignals: false,
  })
  app = (server as unknown as { app: express.Express }).app
}, 60000)

afterAll(async () => {
  if (seededInstances.length > 0) {
    await db().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [seededInstances])
    await db().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [seededInstances])
  }
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
})

describe('todo center task source under the production wiring', () => {
  it('todo-source|with the task routes on, the server registers both sources', () => {
    expect(pendingSourceRegistry.sourceNames()).toEqual(['approval', 'task'])
  })

  it('todo-source|a viewer with task access sees their open tasks; the badge number stays separate', async () => {
    const reader = await actor('reader1', ['tasks:read'], true)
    const dueLater = await assignedTask([reader.userId], { dueDate: nextWeek(), timeZone: 'Asia/Shanghai' })
    const noDue = await assignedTask([reader.userId])
    const finished = await assignedTask([reader.userId])
    await completeTask({ orgId: ORG_A, actorId: reader.userId, taskId: finished })
    await assignedTask([otherId])

    const items = await get(ITEMS, reader.bearer)
    expect(items.status).toBe(200)
    expect(items.body.sources).toEqual({ task: 'ok' })
    expect(ids(items.body)).toEqual([dueLater, noDue].sort())
    for (const item of items.body.items) {
      expect(item.source).toBe('task')
      expect(item.href).toBe(`/tasks/${item.id}`)
    }

    const count = await get(COUNT, reader.bearer)
    expect(count.status).toBe(200)
    expect(count.body).toEqual({ count: 2, sources: { task: 'ok' } })

    const badge = await get(BADGE, reader.bearer)
    expect(badge.status).toBe(200)
    expect(badge.body).toEqual({ count: 0 })
  })

  it('todo-source|the badge setting does not change the center count', async () => {
    const writer = await actor('writer2', ['tasks:read', 'tasks:write'], true)
    await assignedTask([writer.userId], { dueDate: nextWeek(), timeZone: 'Asia/Shanghai' })
    await assignedTask([writer.userId])

    const patched = await request(app)
      .patch('/api/task-settings')
      .set('Authorization', `Bearer ${writer.bearer}`)
      .send({ badgeScope: 'off' })
    expect(patched.status).toBe(200)

    const count = await get(COUNT, writer.bearer)
    expect(count.body).toEqual({ count: 2, sources: { task: 'ok' } })
    const badge = await get(BADGE, writer.bearer)
    expect(badge.body).toEqual({ count: 0, badgeScope: 'off' })
  })

  it('todo-source|task access alone shows no approval source, even with a seat on an approval', async () => {
    const reader = await actor('reader3', ['tasks:read'], true)
    const instance = await approvalSeat(reader.userId)

    const items = await get(ITEMS, reader.bearer)
    expect(items.status).toBe(200)
    expect(items.body.sources).toEqual({ task: 'ok' })
    expect(ids(items.body)).not.toContain(instance)
    const count = await get(COUNT, reader.bearer)
    expect(count.body).toEqual({ count: 0, sources: { task: 'ok' } })
  })

  it('todo-source|approval access alone shows no task source, even when assigned to a task', async () => {
    const approver = await actor('approver4', ['approvals:read'], false)
    const task = await assignedTask([approver.userId])
    const instance = await approvalSeat(approver.userId)

    const items = await get(ITEMS, approver.bearer)
    expect(items.status).toBe(200)
    expect(items.body.sources).toEqual({ approval: 'ok' })
    expect(ids(items.body)).toEqual([instance])
    expect(ids(items.body)).not.toContain(task)
    const count = await get(COUNT, approver.bearer)
    expect(count.body).toEqual({ count: 1, sources: { approval: 'ok' } })
  })

  it('todo-source|a task role without task access enabled gets the same 403 as the task routes', async () => {
    const reader = await actor('noentry5', ['tasks:read'], false)
    for (const path of [ITEMS, COUNT, '/api/tasks?view=assigned']) {
      const response = await get(path, reader.bearer)
      expect(response.status, path).toBe(403)
      expect(response.text, path).toBe(FORBIDDEN_BODY)
    }
  })

  it('todo-source|a viewer with neither code gets 403', async () => {
    const nobody = await actor('nobody6', [], false)
    for (const path of [ITEMS, COUNT]) {
      const response = await get(path, nobody.bearer)
      expect(response.status, path).toBe(403)
      expect(response.text, path).toBe(FORBIDDEN_BODY)
    }
  })

  it('todo-source|an administrator sees both sources', async () => {
    const admin = await actor('admin6', [], false)
    await db().query(`INSERT INTO roles (id, name) VALUES ('admin', 'admin') ON CONFLICT (id) DO NOTHING`)
    await db().query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [admin.userId, 'admin'])

    const items = await get(ITEMS, admin.bearer)
    expect(items.status).toBe(200)
    expect(items.body.sources).toEqual({ approval: 'ok', task: 'ok' })
    const count = await get(COUNT, admin.bearer)
    expect(count.body.sources).toEqual({ approval: 'ok', task: 'ok' })
  })

  it('todo-source|rows are limited to the organization of the session', async () => {
    const reader = await actor('reader7', ['tasks:read'], true, ORG_B)
    await db().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [reader.userId, ORG_A])
    const task = await assignedTask([reader.userId])

    const plain = await get(ITEMS, reader.bearer)
    expect(plain.body.sources).toEqual({ task: 'ok' })
    expect(ids(plain.body)).toEqual([])

    const withHeader = await get(ITEMS, reader.bearer).set('x-tenant-id', ORG_A)
    expect(withHeader.body.sources).toEqual({ task: 'ok' })
    expect(ids(withHeader.body)).toEqual([])

    // The row is there for a session in the row's organization.
    const inOrgA = await get(ITEMS, signTaskToken(reader.userId, reader.roleId, ORG_A))
    expect(ids(inOrgA.body)).toEqual([task])
  })

  it('todo-source|the sources query narrows what task access shows', async () => {
    const reader = await actor('reader8', ['tasks:read'], true)
    await assignedTask([reader.userId])

    const approvalOnly = await get(`${COUNT}?sources=approval`, reader.bearer)
    expect(approvalOnly.status).toBe(200)
    expect(approvalOnly.body).toEqual({ count: 0, sources: {} })

    const taskOnly = await get(`${COUNT}?sources=task`, reader.bearer)
    expect(taskOnly.body).toEqual({ count: 1, sources: { task: 'ok' } })

    const repeated = await get(`${COUNT}?sources=task&sources=approval`, reader.bearer)
    expect(repeated.status).toBe(200)
    expect(repeated.body).toEqual({ count: 1, sources: { task: 'ok' } })
  })

  it('todo-source|organization comes from the session, not from request metadata', async () => {
    const reader = await actor('reader9', ['tasks:read'], true)
    const task = await assignedTask([reader.userId])
    const noOrgToken = signTaskToken(reader.userId, reader.roleId, '')

    for (const send of [
      (path: string) => get(path, noOrgToken).set('x-tenant-id', ORG_A),
      (path: string) => get(path, noOrgToken),
    ]) {
      const items = await send(ITEMS)
      expect(items.status).toBe(200)
      expect(items.body.sources).toEqual({ task: 'unavailable' })
      expect(items.body.items).toEqual([])
      const count = await send(COUNT)
      expect(count.status).toBe(200)
      expect(count.body).toEqual({ count: 0, sources: { task: 'unavailable' } })
    }

    // The same person with an organization in the session sees the row.
    const withOrg = await get(ITEMS, reader.bearer)
    expect(ids(withOrg.body)).toEqual([task])
  })

  it('todo-source|a task I finished is not pending for me while another assignee is still open', async () => {
    const reader = await actor('reader10', ['tasks:read'], true)
    const task = await assignedTask([reader.userId, otherId])
    await completeTask({ orgId: ORG_A, actorId: reader.userId, taskId: task })

    const items = await get(ITEMS, reader.bearer)
    expect(ids(items.body)).toEqual([])

    const assigned = await get('/api/tasks?view=assigned', reader.bearer)
    expect(assigned.status).toBe(200)
    expect(ids(assigned.body)).toContain(task)
  })
})
