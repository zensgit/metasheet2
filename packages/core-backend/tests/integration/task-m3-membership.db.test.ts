/**
 * M3 (P0-B) membership: assignees, followers, leave, completion-mode switch.
 * Gate 3's increase/decrease-member and switch-mode cells go over HTTP
 * (contract §5), asserting the §6.2 any-mode invariant across the whole test
 * org after every operation, not just the target task.
 */
import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import type supertest from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { completeTask, createTask, getTask } from '../../src/services/task-records'
import {
  addAssignee,
  addFollower,
  deleteTaskById,
  leaveTask,
  removeAssignee,
  removeFollower,
  switchCompletionMode,
} from '../../src/services/task-structure'
import { taskStructureLockKey } from '../../src/tasks/task-lock-keys'
import {
  createActorFixture,
  rawRequest,
  startTasksListener,
  tasksClient,
  type TasksClient,
  type TasksListener,
} from '../helpers/tasks-http-harness'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m3-membership.db.test.ts requires EXPECT_DB=1')
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('task-m3-membership.db.test.ts requires JWT_SECRET')
}

const ORG_PREFIX = 'org_tasks_m3mem_'

// One listener for the whole file, `Connection: close` on every request
// (M3R2-CONC-6); see tests/helpers/tasks-http-harness.ts.
let listener: TasksListener | undefined
function app(): TasksClient {
  return tasksClient(listener?.baseUrl ?? '')
}
function listenerPort(): number {
  if (!listener) throw new Error('tasks listener not started')
  return listener.port
}

// Records every actor it provisions; afterAll removes their RBAC rows
// (M3R2-TM-9).
const actors = createActorFixture('tasks-m3mem.test', JWT_SECRET)
const actorBearer = actors.bearer

function ids(label: string): { orgId: string; userA: string; userB: string } {
  const stamp = randomUUID()
  return {
    orgId: `${ORG_PREFIX}${label}_${stamp}`,
    userA: `usrA_${label}_${stamp}`,
    userB: `usrB_${label}_${stamp}`,
  }
}

async function assertAnyModeInvariant(orgId: string): Promise<void> {
  const result = await poolManager.get().query<{ id: string }>(
    `SELECT DISTINCT t.id FROM tasks t JOIN task_assignees a ON a.task_id = t.id
     WHERE t.org_id = $1 AND t.status = 'open' AND t.completion_mode = 'any' AND a.completed_at IS NOT NULL`,
    [orgId],
  )
  expect(result.rows).toEqual([])
}

/** §2's other per-org invariant: `status='done'` iff `tasks.completed_at IS
 * NOT NULL`, so a mode switch or membership write can never leave a `done`
 * task with a null completion timestamp, or vice versa (M3-CONC-3/M3G-3). */
async function assertDoneCompletedAtInvariant(orgId: string): Promise<void> {
  const result = await poolManager.get().query<{ id: string }>(
    `SELECT id FROM tasks
     WHERE org_id = $1 AND ((status = 'done') IS DISTINCT FROM (completed_at IS NOT NULL))`,
    [orgId],
  )
  expect(result.rows).toEqual([])
}

async function taskRow(taskId: string): Promise<{ status: string; version: number; completionMode: string }> {
  const result = await poolManager.get().query<{ status: string; version: number; completion_mode: string }>(
    'SELECT status, version, completion_mode FROM tasks WHERE id = $1',
    [taskId],
  )
  const row = result.rows[0]
  if (!row) throw new Error('task missing')
  return { status: row.status, version: Number(row.version), completionMode: row.completion_mode }
}

/** DB read-back of `task_assignees`, shaped exactly like a membership
 * response's `assignees` array (same sort, same `completedAt` shape) so a
 * test can compare the two directly (M3-CONC-2). */
async function assigneeRows(taskId: string): Promise<Array<{ userId: string; completedAt: string | null }>> {
  const result = await poolManager.get().query<{ user_id: string; completed_at: Date | string | null }>(
    'SELECT user_id, completed_at FROM task_assignees WHERE task_id = $1 ORDER BY user_id',
    [taskId],
  )
  return result.rows.map((row) => ({
    userId: row.user_id,
    completedAt: row.completed_at === null
      ? null
      : row.completed_at instanceof Date ? row.completed_at.toISOString() : new Date(String(row.completed_at)).toISOString(),
  }))
}

/** DB read-back of `task_followers` (M3-CONC-2). */
async function followerRows(taskId: string): Promise<string[]> {
  const result = await poolManager.get().query<{ user_id: string }>(
    'SELECT user_id FROM task_followers WHERE task_id = $1 ORDER BY user_id',
    [taskId],
  )
  return result.rows.map((row) => row.user_id)
}

/** Full membership+version+mode snapshot, used by the row-level 404 cells
 * (M3-AUTHZ-2/M3G-1) to assert a rejected write left the task untouched. */
/** Every column of the task row, as JSON, for before/after equality. */
async function wholeTaskRow(taskId: string): Promise<unknown> {
  const result = await poolManager.get().query<{ row: unknown }>('SELECT to_jsonb(t) AS row FROM tasks t WHERE id = $1', [taskId])
  return result.rows[0]?.row
}

async function membershipSnapshot(taskId: string): Promise<{
  assignees: Array<{ userId: string; completedAt: string | null }>
  followers: string[]
  version: number
  completionMode: string
}> {
  const [assignees, followers, task] = await Promise.all([assigneeRows(taskId), followerRows(taskId), taskRow(taskId)])
  return { assignees, followers, version: task.version, completionMode: task.completionMode }
}

describe('tasks M3 membership real db', () => {
  beforeAll(async () => {
    listener = await startTasksListener()
  })

  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', [`${ORG_PREFIX}%`])
    await actors.cleanup()
    await listener?.close()
  })

  describe('gate 3: add/remove assignee x all/any x done/open, over HTTP', () => {
    it('all mode: adding an assignee to a done task reopens it (version +1)', async () => {
      const { orgId, userA, userB } = ids('all-add-reopen')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'all' })
      const server = app()
      const complete = await server.post(`/api/tasks/${created.id}/complete`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({})
      expect(complete.status).toBe(200)
      expect(await taskRow(created.id)).toMatchObject({ status: 'done', version: 2 })
      // M3G-10: assert the invariant right after the seed complete, too.
      await assertAnyModeInvariant(orgId)

      const add = await server.post(`/api/tasks/${created.id}/assignees`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({ userId: userB })
      expect(add.status).toBe(200)
      expect(add.body).toMatchObject({ id: created.id, status: 'open', completionMode: 'all' })
      expect(add.body.assignees.map((a: { userId: string }) => a.userId).sort()).toEqual([userA, userB].sort())
      expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 3 })
      // M3-CONC-2: the response body is built from the write's own in-memory
      // result, not re-read from storage — confirm the row actually landed.
      expect(await assigneeRows(created.id)).toEqual(add.body.assignees)
      await assertAnyModeInvariant(orgId)
      await assertDoneCompletedAtInvariant(orgId)
    })

    it('all mode: adding an assignee to an open task with an incomplete row stays open (no version bump)', async () => {
      const { orgId, userA, userB } = ids('all-add-open')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'all' })
      expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })
      const server = app()
      const add = await server.post(`/api/tasks/${created.id}/assignees`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({ userId: userB })
      expect(add.status).toBe(200)
      expect(add.body.status).toBe('open')
      expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })
      expect(await assigneeRows(created.id)).toEqual(add.body.assignees)
      await assertAnyModeInvariant(orgId)
    })

    it('all mode: removing the last incomplete assignee promotes the task to done', async () => {
      const { orgId, userA, userB } = ids('all-remove-promote')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB], completionMode: 'all' })
      const server = app()
      const completeA = await server.post(`/api/tasks/${created.id}/complete`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({})
      expect(completeA.status).toBe(200)
      expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })
      // M3G-10: assert the invariant right after the seed complete, too.
      await assertAnyModeInvariant(orgId)

      const removeB = await server.delete(`/api/tasks/${created.id}/assignees/${userB}`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`)
      expect(removeB.status).toBe(200)
      expect(removeB.body).toMatchObject({ id: created.id, status: 'done' })
      expect(removeB.body.assignees).toEqual([{ userId: userA, completedAt: expect.any(String) }])
      expect(await taskRow(created.id)).toMatchObject({ status: 'done', version: 2 })
      // M3-CONC-2: the removed row is actually gone from storage, and B has
      // lost the abilities that came from being an assignee.
      expect(await assigneeRows(created.id)).toEqual([{ userId: userA, completedAt: expect.any(String) }])
      const getAsB = await server.get(`/api/tasks/${created.id}`).set('Authorization', `Bearer ${await actorBearer(orgId, userB)}`)
      expect(getAsB.status).toBe(404)
      await assertAnyModeInvariant(orgId)
      await assertDoneCompletedAtInvariant(orgId)
    })

    it('all mode: removing one of two incomplete assignees stays open', async () => {
      const { orgId, userA, userB } = ids('all-remove-open')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB], completionMode: 'all' })
      const server = app()
      const removeB = await server.delete(`/api/tasks/${created.id}/assignees/${userB}`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`)
      expect(removeB.status).toBe(200)
      expect(removeB.body.status).toBe('open')
      expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })
      expect(await assigneeRows(created.id)).toEqual(removeB.body.assignees)
      await assertAnyModeInvariant(orgId)
    })

    it('any mode: adding an assignee to an open task never flips status', async () => {
      const { orgId, userA, userB } = ids('any-add-open')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'any' })
      const server = app()
      const add = await server.post(`/api/tasks/${created.id}/assignees`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({ userId: userB })
      expect(add.status).toBe(200)
      expect(add.body.status).toBe('open')
      expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })
      expect(await assigneeRows(created.id)).toEqual(add.body.assignees)
      await assertAnyModeInvariant(orgId)
    })

    it('any mode: adding an assignee to an already-done task leaves it done (A1)', async () => {
      const { orgId, userA, userB } = ids('any-add-done')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'any' })
      const server = app()
      const complete = await server.post(`/api/tasks/${created.id}/complete`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({})
      expect(complete.status).toBe(200)
      expect(await taskRow(created.id)).toMatchObject({ status: 'done', version: 2 })
      // M3G-10: assert the invariant right after the seed complete, too.
      await assertAnyModeInvariant(orgId)

      const add = await server.post(`/api/tasks/${created.id}/assignees`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({ userId: userB })
      expect(add.status).toBe(200)
      expect(add.body.status).toBe('done')
      expect(await taskRow(created.id)).toMatchObject({ status: 'done', version: 2 })
      const addedRow = add.body.assignees.find((a: { userId: string }) => a.userId === userB)
      expect(addedRow.completedAt).toBeNull()
      expect(await assigneeRows(created.id)).toEqual(add.body.assignees)
      await assertAnyModeInvariant(orgId)
    })

    it('any mode: removing the only (completed) assignee leaves status untouched (A2)', async () => {
      const { orgId, userA } = ids('any-remove-untouched')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'any' })
      const server = app()
      const complete = await server.post(`/api/tasks/${created.id}/complete`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({})
      expect(complete.status).toBe(200)
      expect(await taskRow(created.id)).toMatchObject({ status: 'done' })
      await assertAnyModeInvariant(orgId)

      const remove = await server.delete(`/api/tasks/${created.id}/assignees/${userA}`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`)
      expect(remove.status).toBe(200)
      expect(remove.body.status).toBe('done')
      expect(remove.body.assignees).toEqual([])
      expect(await taskRow(created.id)).toMatchObject({ status: 'done' })
      expect(await assigneeRows(created.id)).toEqual([])
      await assertAnyModeInvariant(orgId)
    })

    it('all mode: removing an assignee from an already-done task stays done (no version bump)', async () => {
      const { orgId, userA, userB } = ids('all-remove-done')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB], completionMode: 'all' })
      const server = app()
      const bearerA = await actorBearer(orgId, userA)
      const completeA = await server.post(`/api/tasks/${created.id}/complete`).set('Authorization', `Bearer ${bearerA}`).send({})
      expect(completeA.status).toBe(200)
      await assertAnyModeInvariant(orgId)
      const completeB = await server.post(`/api/tasks/${created.id}/complete`).set('Authorization', `Bearer ${await actorBearer(orgId, userB)}`).send({})
      expect(completeB.status).toBe(200)
      expect(await taskRow(created.id)).toMatchObject({ status: 'done', version: 2 })
      await assertAnyModeInvariant(orgId)

      const remove = await server.delete(`/api/tasks/${created.id}/assignees/${userB}`).set('Authorization', `Bearer ${bearerA}`)
      expect(remove.status).toBe(200)
      expect(remove.body.status).toBe('done')
      expect(remove.body.assignees).toEqual([{ userId: userA, completedAt: expect.any(String) }])
      expect(await taskRow(created.id)).toMatchObject({ status: 'done', version: 2 })
      expect(await assigneeRows(created.id)).toEqual([{ userId: userA, completedAt: expect.any(String) }])
      await assertAnyModeInvariant(orgId)
      await assertDoneCompletedAtInvariant(orgId)
    })

    it('any mode: removing the only (incomplete) assignee from an open task stays open', async () => {
      const { orgId, userA } = ids('any-remove-open')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'any' })
      const server = app()
      const remove = await server.delete(`/api/tasks/${created.id}/assignees/${userA}`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`)
      expect(remove.status).toBe(200)
      expect(remove.body.status).toBe('open')
      expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })
      expect(await assigneeRows(created.id)).toEqual([])
      await assertAnyModeInvariant(orgId)
    })

    it('an already-assignee add and an already-removed remove are noops (200, no event, no version bump)', async () => {
      const { orgId, userA, userB } = ids('noop')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'all' })
      const server = app()
      const bearerA = await actorBearer(orgId, userA)
      const addAgain = await server.post(`/api/tasks/${created.id}/assignees`).set('Authorization', `Bearer ${bearerA}`).send({ userId: userA })
      expect(addAgain.status).toBe(200)
      expect(await taskRow(created.id)).toMatchObject({ version: 1 })
      expect(await assigneeRows(created.id)).toEqual([{ userId: userA, completedAt: null }])
      await assertAnyModeInvariant(orgId)
      const removeNotThere = await server.delete(`/api/tasks/${created.id}/assignees/${userB}`).set('Authorization', `Bearer ${bearerA}`)
      expect(removeNotThere.status).toBe(200)
      expect(await taskRow(created.id)).toMatchObject({ version: 1 })
      expect(await assigneeRows(created.id)).toEqual([{ userId: userA, completedAt: null }])
      const events = await poolManager.get().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND event_type IN ('assignee_added', 'assignee_removed')`,
        [created.id],
      )
      expect(events.rows[0]?.n).toBe('0')
      await assertAnyModeInvariant(orgId)
    })
  })

  describe('completion-mode switch (§3.4, and version rule)', () => {
    it('all -> any while open with someone already complete makes the task done in one version bump, stamping every remaining row to ONE shared instant (M3-CONC-3/M3G-3)', async () => {
      const { orgId, userA, userB } = ids('switch-done')
      const userC = `usrC_switchdone_${randomUUID()}`
      // THREE assignees, TWO of them incomplete before the switch — a
      // single incomplete row cannot show "every open row shares one
      // instant" (there is nothing else to compare it to).
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB, userC], completionMode: 'all' })
      const server = app()
      await server.post(`/api/tasks/${created.id}/complete`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({})
      expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })
      // M3G-10: assert the invariant right after the seed complete, too.
      await assertAnyModeInvariant(orgId)
      const beforeSwitch = await assigneeRows(created.id)
      const aStampBefore = beforeSwitch.find((r) => r.userId === userA)?.completedAt
      expect(aStampBefore).toEqual(expect.any(String))

      const switchRes = await server.patch(`/api/tasks/${created.id}/completion-mode`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({ completionMode: 'any' })
      expect(switchRes.status).toBe(200)
      expect(switchRes.body).toMatchObject({ id: created.id, status: 'done', completionMode: 'any' })
      // Exactly one version bump covers both the mode change and the status flip.
      expect(await taskRow(created.id)).toMatchObject({ status: 'done', version: 2, completionMode: 'any' })
      const storedTask = await poolManager.get().query<{ completed_at: Date }>('SELECT completed_at FROM tasks WHERE id = $1', [created.id])
      const completedAt = storedTask.rows[0]?.completed_at
      expect(completedAt).toBeTruthy()
      const completedAtIso = (completedAt as Date).toISOString()
      const stamps = switchRes.body.assignees.map((a: { completedAt: string | null }) => a.completedAt)
      expect(stamps.every((s: string | null) => s !== null)).toBe(true)

      // M3-CONC-2/M3-CONC-3: read back the ACTUAL rows, not just the response
      // body — B and C were both incomplete before the switch, so both must
      // now be stamped to the SAME instant as tasks.completed_at (§13-9),
      // and A's own (earlier) stamp must be untouched.
      const afterSwitch = await assigneeRows(created.id)
      const bStamp = afterSwitch.find((r) => r.userId === userB)?.completedAt
      const cStamp = afterSwitch.find((r) => r.userId === userC)?.completedAt
      expect(bStamp).toBe(completedAtIso)
      expect(cStamp).toBe(completedAtIso)
      const aStampAfter = afterSwitch.find((r) => r.userId === userA)?.completedAt
      expect(aStampAfter).toBe(aStampBefore)

      const events = await poolManager.get().query<{ event_type: string }>(
        `SELECT event_type FROM task_events WHERE task_id = $1 AND event_type IN ('completion_mode_changed', 'completed_by_any') ORDER BY event_type`,
        [created.id],
      )
      expect(events.rows.map((r) => r.event_type)).toEqual(['completed_by_any', 'completion_mode_changed'])
      await assertAnyModeInvariant(orgId)
      await assertDoneCompletedAtInvariant(orgId)
    })

    it('all -> any while open with nobody complete stays open (mode-only update, no version bump)', async () => {
      const { orgId, userA, userB } = ids('switch-open')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB], completionMode: 'all' })
      const server = app()
      const switchRes = await server.patch(`/api/tasks/${created.id}/completion-mode`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({ completionMode: 'any' })
      expect(switchRes.status).toBe(200)
      expect(switchRes.body).toMatchObject({ status: 'open', completionMode: 'any' })
      expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1, completionMode: 'any' })
      await assertAnyModeInvariant(orgId)
    })

    it('any -> all preserves rows and an already-done status', async () => {
      const { orgId, userA } = ids('switch-any-all')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'any' })
      const server = app()
      await server.post(`/api/tasks/${created.id}/complete`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({})
      expect(await taskRow(created.id)).toMatchObject({ status: 'done', version: 2 })
      await assertAnyModeInvariant(orgId)
      const switchRes = await server.patch(`/api/tasks/${created.id}/completion-mode`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({ completionMode: 'all' })
      expect(switchRes.status).toBe(200)
      expect(switchRes.body).toMatchObject({ status: 'done', completionMode: 'all' })
      expect(await taskRow(created.id)).toMatchObject({ status: 'done', version: 2, completionMode: 'all' })
      await assertAnyModeInvariant(orgId)
    })

    it('same mode is a noop: 200, no event, no version bump', async () => {
      const { orgId, userA } = ids('switch-noop')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'all' })
      const server = app()
      const before = await poolManager.get().query<{ n: string }>(`SELECT count(*)::text AS n FROM task_events WHERE task_id = $1`, [created.id])
      const switchRes = await server.patch(`/api/tasks/${created.id}/completion-mode`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({ completionMode: 'all' })
      expect(switchRes.status).toBe(200)
      expect(await taskRow(created.id)).toMatchObject({ version: 1 })
      const after = await poolManager.get().query<{ n: string }>(`SELECT count(*)::text AS n FROM task_events WHERE task_id = $1`, [created.id])
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
      await assertAnyModeInvariant(orgId)
    })

    it('an invalid completionMode is 422 INVALID_MODE (reused from M2, not a new code)', async () => {
      const { orgId, userA } = ids('switch-invalid')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'all' })
      const server = app()
      const bad = await server.patch(`/api/tasks/${created.id}/completion-mode`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({ completionMode: 'sometimes' })
      expect(bad.status).toBe(422)
      expect(bad.body).toEqual({ error: { code: 'INVALID_MODE' } })
      await assertAnyModeInvariant(orgId)
    })
  })

  describe('followers and leave (§3.5)', () => {
    it('adds, no-ops on a duplicate add, and lets another editor remove a follower', async () => {
      const { orgId, userA, userB } = ids('followers')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const server = app()
      const bearerA = await actorBearer(orgId, userA)
      const add = await server.post(`/api/tasks/${created.id}/followers`).set('Authorization', `Bearer ${bearerA}`).send({ userId: userB })
      expect(add.status).toBe(200)
      expect(add.body).toEqual({ id: created.id, followers: [userB] })
      // M3-CONC-2: the follower row is actually written, not just echoed
      // back in the response.
      expect(await followerRows(created.id)).toEqual([userB])
      const addAgain = await server.post(`/api/tasks/${created.id}/followers`).set('Authorization', `Bearer ${bearerA}`).send({ userId: userB })
      expect(addAgain.status).toBe(200)
      expect(addAgain.body.followers).toEqual([userB])
      const remove = await server.delete(`/api/tasks/${created.id}/followers/${userB}`).set('Authorization', `Bearer ${bearerA}`)
      expect(remove.status).toBe(200)
      expect(remove.body).toEqual({ id: created.id, followers: [] })
      expect(await followerRows(created.id)).toEqual([])
      const events = await poolManager.get().query<{ event_type: string; payload: { targetUserId?: string } }>(
        `SELECT event_type, payload FROM task_events WHERE task_id = $1 AND event_type IN ('follower_added', 'follower_removed') ORDER BY event_type`,
        [created.id],
      )
      expect(events.rows).toHaveLength(2)
      for (const row of events.rows) expect(row.payload.targetUserId).toBe(userB)
    })

    it('leave works only for followers; a non-follower gets 404', async () => {
      const { orgId, userA, userB } = ids('leave')
      const follower = `usrF_leave_${randomUUID()}`
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const server = app()
      await server.post(`/api/tasks/${created.id}/followers`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`).send({ userId: follower })

      const notAFollower = await server.post(`/api/tasks/${created.id}/leave`).set('Authorization', `Bearer ${await actorBearer(orgId, userB)}`)
      expect(notAFollower.status).toBe(404)
      expect(notAFollower.body).toEqual({ error: { code: 'NOT_FOUND' } })

      const leftRes = await server.post(`/api/tasks/${created.id}/leave`).set('Authorization', `Bearer ${await actorBearer(orgId, follower)}`)
      expect(leftRes.status).toBe(200)
      expect(leftRes.body).toEqual({ id: created.id, followers: [] })
      expect(await followerRows(created.id)).toEqual([])
      const events = await poolManager.get().query<{ event_type: string; actor_id: string }>(
        `SELECT event_type, actor_id FROM task_events WHERE task_id = $1 AND event_type = 'left'`,
        [created.id],
      )
      expect(events.rows).toEqual([{ event_type: 'left', actor_id: follower }])
    })

    // M3R2-AUTHZ-6/TM-8 (S14): `leave` is follower-only; creator and assignee
    // can view the task, so only the ability, not visibility, rejects them.
    it('leave by the creator or an assignee who is not a follower is 404 and writes nothing', async () => {
      const { orgId, userA, userB } = ids('leavenonfollower')
      const follower = `usrF_leavenf_${randomUUID()}`
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userB] })
      await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, follower])
      const server = app()
      const before = await membershipSnapshot(created.id)
      for (const actor of [userA, userB]) {
        const res = await server.post(`/api/tasks/${created.id}/leave`).set('Authorization', `Bearer ${await actorBearer(orgId, actor)}`)
        expect(res.status, actor).toBe(404)
        expect(res.body, actor).toEqual({ error: { code: 'NOT_FOUND' } })
      }
      expect(await membershipSnapshot(created.id)).toEqual(before)
      const events = await poolManager.get().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND event_type = 'left'`,
        [created.id],
      )
      expect(events.rows[0]?.n).toBe('0')
    })

    it('follower/assignee soft limit is 422 LIMIT', async () => {
      const { orgId, userA } = ids('limit')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const values: string[] = []
      const params: string[] = [created.id]
      for (let i = 0; i < 50; i += 1) {
        params.push(`usr_limit_${i}_${randomUUID()}`)
        values.push(`($1, $${params.length})`)
      }
      await poolManager.get().query(
        `INSERT INTO task_followers (task_id, user_id) VALUES ${values.join(', ')}`,
        params,
      )
      const server = app()
      const overLimit = await server
        .post(`/api/tasks/${created.id}/followers`)
        .set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`)
        .send({ userId: `usr_limit_over_${randomUUID()}` })
      expect(overLimit.status).toBe(422)
      expect(overLimit.body).toEqual({ error: { code: 'LIMIT' } })
    })

    it('assignee soft limit is 422 LIMIT and writes nothing (M3G-9)', async () => {
      const { orgId, userA } = ids('alimit')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      // createTask already inserted the creator row: 49 more makes exactly 50.
      const values: string[] = []
      const params: string[] = [created.id]
      for (let i = 0; i < 49; i += 1) {
        params.push(`usr_alimit_${i}_${randomUUID()}`)
        values.push(`($1, $${params.length})`)
      }
      await poolManager.get().query(
        `INSERT INTO task_assignees (task_id, user_id) VALUES ${values.join(', ')}`,
        params,
      )
      const before = await membershipSnapshot(created.id)
      expect(before.assignees).toHaveLength(50)
      const server = app()
      const overLimit = await server
        .post(`/api/tasks/${created.id}/assignees`)
        .set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`)
        .send({ userId: `usr_alimit_over_${randomUUID()}` })
      expect(overLimit.status).toBe(422)
      expect(overLimit.body).toEqual({ error: { code: 'LIMIT' } })
      expect(await membershipSnapshot(created.id)).toEqual(before)
      const events = await poolManager.get().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND event_type = 'assignee_added'`,
        [created.id],
      )
      expect(events.rows[0]?.n).toBe('0')
    })
  })

  describe('row-level 404 on the five membership/mode writes (M3-AUTHZ-2/M3G-1)', () => {
    type MembershipCase = {
      label: string
      send: (server: TasksClient, taskId: string, bearer: string) => supertest.Test
    }
    const cases: MembershipCase[] = [
      { label: 'POST assignees', send: (server, id, bearer) => server.post(`/api/tasks/${id}/assignees`).set('Authorization', `Bearer ${bearer}`).send({ userId: 'usr_row_target' }) },
      { label: 'DELETE assignees/:userId', send: (server, id, bearer) => server.delete(`/api/tasks/${id}/assignees/usr_seed_assignee`).set('Authorization', `Bearer ${bearer}`) },
      { label: 'PATCH completion-mode', send: (server, id, bearer) => server.patch(`/api/tasks/${id}/completion-mode`).set('Authorization', `Bearer ${bearer}`).send({ completionMode: 'any' }) },
      { label: 'POST followers', send: (server, id, bearer) => server.post(`/api/tasks/${id}/followers`).set('Authorization', `Bearer ${bearer}`).send({ userId: 'usr_row_target' }) },
      { label: 'DELETE followers/:userId', send: (server, id, bearer) => server.delete(`/api/tasks/${id}/followers/usr_seed_follower`).set('Authorization', `Bearer ${bearer}`) },
    ]

    async function seedTask(orgId: string, userA: string): Promise<{ id: string }> {
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      await poolManager.get().query('INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2)', [task.id, 'usr_seed_assignee'])
      await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [task.id, 'usr_seed_follower'])
      return task
    }

    // it.each so a single combined mutant (e.g. stripping all five
    // `assertRowAbility(..., 'edit')` lines at once) turns each of these
    // five tests red independently, in one run — a shared `it` with a loop
    // would stop at the first failure and hide the rest.
    it.each(cases)('$label: an outsider, a view-only follower, and a soft-deleted task each 404; the creator succeeds', async ({ label, send }) => {
      const stamp = randomUUID()
      const orgId = `${ORG_PREFIX}rowauthz_${stamp}`
      const userA = `usrA_rowauthz_${stamp}`
      const outsider = `usrO_rowauthz_${stamp}`
      const follower = `usrF_rowauthz_${stamp}`
      const server = app()
      const bearerA = await actorBearer(orgId, userA)
      const bearerOutsider = await actorBearer(orgId, outsider)
      const bearerFollower = await actorBearer(orgId, follower)

      // Outsider: same org, no relation to the task at all.
      const t1 = await seedTask(orgId, userA)
      const before1 = await membershipSnapshot(t1.id)
      const outsiderRes = await send(server, t1.id, bearerOutsider)
      expect(outsiderRes.status, label).toBe(404)
      expect(outsiderRes.body, label).toEqual({ error: { code: 'NOT_FOUND' } })
      expect(await membershipSnapshot(t1.id), label).toEqual(before1)

      // Follower: view/comment/leave only, no edit.
      const t2 = await seedTask(orgId, userA)
      await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [t2.id, follower])
      const before2 = await membershipSnapshot(t2.id)
      const followerRes = await send(server, t2.id, bearerFollower)
      expect(followerRes.status, label).toBe(404)
      expect(followerRes.body, label).toEqual({ error: { code: 'NOT_FOUND' } })
      expect(await membershipSnapshot(t2.id), label).toEqual(before2)

      // Soft-deleted task: even the creator now gets 404.
      const t3 = await seedTask(orgId, userA)
      const delRes = await server.delete(`/api/tasks/${t3.id}`).set('Authorization', `Bearer ${bearerA}`)
      expect(delRes.status, label).toBe(200)
      const deletedRes = await send(server, t3.id, bearerA)
      expect(deletedRes.status, label).toBe(404)
      expect(deletedRes.body, label).toEqual({ error: { code: 'NOT_FOUND' } })

      // Control: the creator succeeds on a live task.
      const t4 = await seedTask(orgId, userA)
      const controlRes = await send(server, t4.id, bearerA)
      expect(controlRes.status, label).toBe(200)
    })
  })

  describe('GET /api/tasks/:id/parent-candidates row-level guard over HTTP (M3-AUTHZ-4/M3G-5)', () => {
    it('an outsider, a view-only follower, and a soft-deleted task 404; the creator succeeds', async () => {
      const { orgId, userA } = ids('candidateshttp')
      const outsider = `usrO_candidateshttp_${randomUUID()}`
      const follower = `usrF_candidateshttp_${randomUUID()}`
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, follower])
      const server = app()

      const gone = await createTask({ orgId, creatorId: userA, title: '已软删', assignees: [userA] })
      await deleteTaskById({ orgId, actorId: userA, taskId: gone.id })
      const goneRes = await server.get(`/api/tasks/${gone.id}/parent-candidates`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`)
      expect(goneRes.status).toBe(404)
      expect(goneRes.body).toEqual({ error: { code: 'NOT_FOUND' } })

      const outsiderRes = await server.get(`/api/tasks/${created.id}/parent-candidates`).set('Authorization', `Bearer ${await actorBearer(orgId, outsider)}`)
      expect(outsiderRes.status).toBe(404)
      expect(outsiderRes.body).toEqual({ error: { code: 'NOT_FOUND' } })

      const followerRes = await server.get(`/api/tasks/${created.id}/parent-candidates`).set('Authorization', `Bearer ${await actorBearer(orgId, follower)}`)
      expect(followerRes.status).toBe(404)
      expect(followerRes.body).toEqual({ error: { code: 'NOT_FOUND' } })

      const creatorRes = await server.get(`/api/tasks/${created.id}/parent-candidates`).set('Authorization', `Bearer ${await actorBearer(orgId, userA)}`)
      expect(creatorRes.status).toBe(200)
      expect(creatorRes.body).toEqual({ items: [] })
    })
  })

  describe('member ids must be printable ids of at most 255 characters, other than "." and ".."', () => {
    /** A printable id of exactly `length` characters, unique per call. */
    function idOfLength(length: number): string {
      const seed = `usr_len_${randomUUID().replace(/-/g, '')}`
      return (seed + 'x'.repeat(length)).slice(0, length)
    }

    type PostCase = { label: string; path: (taskId: string) => string; rows: (taskId: string) => Promise<unknown> }
    const postCases: PostCase[] = [
      { label: 'POST assignees', path: (id) => `/api/tasks/${id}/assignees`, rows: (id) => assigneeRows(id) },
      { label: 'POST followers', path: (id) => `/api/tasks/${id}/followers`, rows: (id) => followerRows(id) },
    ]

    // M3R2-AUTHZ-2/CF-4/TM-4 (POST followers had no cell), M3R2-AUTHZ-5/CF-6/
    // TM-10 (length bound). Every rejected body leaves the member rows, the
    // task row and the membership events unchanged.
    it.each(postCases)('$label: ".", "..", non-printable, non-string, missing and over-length ids are 422 INVALID_ASSIGNEES and write nothing; 255 characters is accepted', async ({ label, path, rows }) => {
      const { orgId, userA } = ids('idpost')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const server = app()
      const bearerA = await actorBearer(orgId, userA)
      const before = await membershipSnapshot(created.id)
      const bodies: Array<Record<string, unknown>> = [
        { userId: '.' }, { userId: '..' }, { userId: '' }, { userId: 'a b' }, { userId: 'a\u0000b' },
        { userId: 'usr_é' }, { userId: 42 }, { userId: null }, { userId: ['usr_x'] }, {},
        { userId: idOfLength(256) }, { userId: idOfLength(3000) },
      ]
      for (const body of bodies) {
        const res = await server.post(path(created.id)).set('Authorization', `Bearer ${bearerA}`).send(body)
        const shown = JSON.stringify(body).slice(0, 60)
        expect(res.status, `${label} ${shown}`).toBe(422)
        expect(res.body, `${label} ${shown}`).toEqual({ error: { code: 'INVALID_ASSIGNEES' } })
      }
      expect(await membershipSnapshot(created.id), label).toEqual(before)
      const events = await poolManager.get().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND event_type IN ('assignee_added', 'follower_added')`,
        [created.id],
      )
      expect(events.rows[0]?.n, label).toBe('0')

      const longest = idOfLength(255)
      const ok = await server.post(path(created.id)).set('Authorization', `Bearer ${bearerA}`).send({ userId: longest })
      expect(ok.status, label).toBe(200)
      expect(JSON.stringify(await rows(created.id)), label).toContain(longest)
    })

    it('POST /api/tasks: an assignee id over 255 characters is 422 INVALID_ASSIGNEES and creates nothing; 255 is accepted', async () => {
      const { orgId, userA } = ids('idcreate')
      const server = app()
      const bearerA = await actorBearer(orgId, userA)
      for (const bad of [idOfLength(256), idOfLength(3000), '..']) {
        const res = await server.post('/api/tasks').set('Authorization', `Bearer ${bearerA}`).send({ title: '任务', assignees: [userA, bad] })
        expect(res.status, bad.slice(0, 20)).toBe(422)
        expect(res.body).toEqual({ error: { code: 'INVALID_ASSIGNEES' } })
      }
      const count = await poolManager.get().query<{ n: string }>('SELECT count(*)::text AS n FROM tasks WHERE org_id = $1', [orgId])
      expect(count.rows[0]?.n).toBe('0')
      const longest = idOfLength(255)
      const ok = await server.post('/api/tasks').set('Authorization', `Bearer ${bearerA}`).send({ title: '任务', assignees: [longest] })
      expect(ok.status).toBe(200)
      expect(await assigneeRows(String(ok.body.id))).toEqual([{ userId: longest, completedAt: null }])
    })

    // M3R3-IN-2: the create ingress enforces the same assignee soft limit
    // (50) as the add route, on distinct ids, after every id is validated.
    it('POST /api/tasks: more than 50 distinct assignees is 422 LIMIT and creates nothing; 50, or 51 entries with a duplicate, is accepted', async () => {
      const { orgId, userA } = ids('createlimit')
      const server = app()
      const bearerA = await actorBearer(orgId, userA)
      const distinct = (n: number) => Array.from({ length: n }, (_, i) => `usr_lim_${String(i).padStart(3, '0')}_${randomUUID().slice(0, 8)}`)
      for (const size of [51, 200]) {
        const res = await server.post('/api/tasks').set('Authorization', `Bearer ${bearerA}`).send({ title: '任务', assignees: distinct(size) })
        expect(res.status, String(size)).toBe(422)
        expect(res.body, String(size)).toEqual({ error: { code: 'LIMIT' } })
      }
      // Validation runs first: an invalid id among 51 is INVALID_ASSIGNEES.
      const withBad = [...distinct(50), '..']
      const bad = await server.post('/api/tasks').set('Authorization', `Bearer ${bearerA}`).send({ title: '任务', assignees: withBad })
      expect(bad.status).toBe(422)
      expect(bad.body).toEqual({ error: { code: 'INVALID_ASSIGNEES' } })
      const none = await poolManager.get().query<{ n: string }>('SELECT count(*)::text AS n FROM tasks WHERE org_id = $1', [orgId])
      expect(none.rows[0]?.n).toBe('0')

      const fifty = distinct(50)
      const ok = await server.post('/api/tasks').set('Authorization', `Bearer ${bearerA}`).send({ title: '任务', assignees: fifty })
      expect(ok.status).toBe(200)
      expect((await assigneeRows(String(ok.body.id))).map((row) => row.userId)).toEqual([...fifty].sort())
      const dup = distinct(50)
      const okDup = await server.post('/api/tasks').set('Authorization', `Bearer ${bearerA}`).send({ title: '任务', assignees: [...dup, dup[7]] })
      expect(okDup.status).toBe(200)
      expect((await assigneeRows(String(okDup.body.id))).map((row) => row.userId)).toEqual([...dup].sort())
      const assignedBy = await poolManager.get().query<{ assigned_by: string; n: string }>(
        'SELECT assigned_by, count(*)::text AS n FROM task_assignees WHERE task_id = $1 GROUP BY assigned_by',
        [String(okDup.body.id)],
      )
      expect(assignedBy.rows).toEqual([{ assigned_by: userA, n: '50' }])
    })

    // Sent with node:http (rawRequest) rather than supertest, so the path
    // bytes reach the server exactly as written.
    type DeleteCase = { label: string; segment: string; seed: (taskId: string, userId: string) => Promise<void>; rows: (taskId: string) => Promise<unknown> }
    const deleteCases: DeleteCase[] = [
      {
        label: 'DELETE assignees/:userId',
        segment: 'assignees',
        seed: async (taskId, userId) => { await poolManager.get().query('INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2)', [taskId, userId]) },
        rows: (id) => assigneeRows(id),
      },
      {
        label: 'DELETE followers/:userId',
        segment: 'followers',
        seed: async (taskId, userId) => { await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [taskId, userId]) },
        rows: (id) => followerRows(id),
      },
    ]

    it.each(deleteCases)('$label: malformed ids are 422 and nothing changes; a 255-character member is removed', async ({ label, segment, seed, rows }) => {
      const { orgId, userA } = ids('iddel')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const longest = idOfLength(255)
      await seed(created.id, longest)
      const bearerA = await actorBearer(orgId, userA)
      const before = await membershipSnapshot(created.id)
      const taskBefore = await wholeTaskRow(created.id)
      for (const bad of ['%2E%2E', '%2E', 'a%00b', idOfLength(256)]) {
        const res = await rawRequest(listenerPort(), 'DELETE', `/api/tasks/${created.id}/${segment}/${bad}`, bearerA)
        expect(res.status, `${label} ${bad.slice(0, 20)}`).toBe(422)
        expect(res.body, `${label} ${bad.slice(0, 20)}`).toEqual({ error: { code: 'INVALID_ASSIGNEES' } })
      }
      expect(await membershipSnapshot(created.id), label).toEqual(before)
      expect(await wholeTaskRow(created.id), label).toEqual(taskBefore)

      const ok = await rawRequest(listenerPort(), 'DELETE', `/api/tasks/${created.id}/${segment}/${longest}`, bearerA)
      expect(ok.status, label).toBe(200)
      expect(JSON.stringify(await rows(created.id)), label).not.toContain(longest)
    })
  })

  // M3R2-TM-8 (S15/S16): the assignee events are written, with the actor and
  // the target.
  describe('assignee events', () => {
    it('a real add and a real remove write assignee_added / assignee_removed with actor_id and payload.targetUserId', async () => {
      const { orgId, userA, userB } = ids('aevents')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const server = app()
      const bearerA = await actorBearer(orgId, userA)
      expect((await server.post(`/api/tasks/${created.id}/assignees`).set('Authorization', `Bearer ${bearerA}`).send({ userId: userB })).status).toBe(200)
      expect((await server.delete(`/api/tasks/${created.id}/assignees/${userB}`).set('Authorization', `Bearer ${bearerA}`)).status).toBe(200)
      const events = await poolManager.get().query<{ event_type: string; actor_id: string; payload: { targetUserId?: string } }>(
        `SELECT event_type, actor_id, payload FROM task_events
         WHERE task_id = $1 AND event_type IN ('assignee_added', 'assignee_removed') ORDER BY event_type`,
        [created.id],
      )
      expect(events.rows).toEqual([
        { event_type: 'assignee_added', actor_id: userA, payload: { targetUserId: userB } },
        { event_type: 'assignee_removed', actor_id: userA, payload: { targetUserId: userB } },
      ])
    })
  })

  // M3R2-TM-6: the route hands the request body to the service.
  describe('PATCH /api/tasks/:id/parent over HTTP', () => {
    it('sets and then clears the parent named in the body; the stored row matches the response', async () => {
      const { orgId, userA } = ids('parenthttp')
      const parent = await createTask({ orgId, creatorId: userA, title: '父', assignees: [userA] })
      const child = await createTask({ orgId, creatorId: userA, title: '子', assignees: [userA] })
      const server = app()
      const bearerA = await actorBearer(orgId, userA)
      const set = await server.patch(`/api/tasks/${child.id}/parent`).set('Authorization', `Bearer ${bearerA}`).send({ parentId: parent.id })
      expect(set.status).toBe(200)
      expect(set.body).toEqual({ id: child.id, parentId: parent.id, depth: 1 })
      const stored = await poolManager.get().query<{ parent_id: string | null; depth: number }>('SELECT parent_id, depth FROM tasks WHERE id = $1', [child.id])
      expect(stored.rows[0]).toEqual({ parent_id: parent.id, depth: 1 })
      const cleared = await server.patch(`/api/tasks/${child.id}/parent`).set('Authorization', `Bearer ${bearerA}`).send({ parentId: null })
      expect(cleared.status).toBe(200)
      expect(cleared.body).toEqual({ id: child.id, parentId: null, depth: 0 })
      const bad = await server.patch(`/api/tasks/${child.id}/parent`).set('Authorization', `Bearer ${bearerA}`).send({ parentId: 'a\u0000b' })
      expect(bad.status).toBe(422)
      expect(bad.body).toEqual({ error: { code: 'INVALID_PARENT' } })
    })
  })

  // M3R2-CONC-2/TM-2. Gate-6-style blocked-waiter cells: a third connection
  // holds the org structure lock, each production write is launched and
  // must queue on that same advisory key (granted=false) without settling;
  // once released, it completes with its normal result.
  describe('gate 6: the six membership/mode writes take the org structure lock', () => {
    type LockCtx = { orgId: string; userA: string; userB: string; userC: string; taskId: string }
    type LockCase = {
      label: string
      run: (c: LockCtx) => Promise<unknown>
      check: (c: LockCtx) => Promise<void>
    }
    const lockCases: LockCase[] = [
      {
        label: 'addAssignee',
        run: (c) => addAssignee({ orgId: c.orgId, actorId: c.userA, taskId: c.taskId, body: { userId: c.userC } }),
        check: async (c) => { expect((await assigneeRows(c.taskId)).map((r) => r.userId)).toContain(c.userC) },
      },
      {
        label: 'removeAssignee',
        run: (c) => removeAssignee({ orgId: c.orgId, actorId: c.userA, taskId: c.taskId, userId: c.userB }),
        check: async (c) => { expect((await assigneeRows(c.taskId)).map((r) => r.userId)).not.toContain(c.userB) },
      },
      {
        label: 'switchCompletionMode',
        run: (c) => switchCompletionMode({ orgId: c.orgId, actorId: c.userA, taskId: c.taskId, body: { completionMode: 'any' } }),
        check: async (c) => { expect((await taskRow(c.taskId)).completionMode).toBe('any') },
      },
      {
        label: 'addFollower',
        run: (c) => addFollower({ orgId: c.orgId, actorId: c.userA, taskId: c.taskId, body: { userId: c.userC } }),
        check: async (c) => { expect(await followerRows(c.taskId)).toContain(c.userC) },
      },
      {
        label: 'removeFollower',
        run: (c) => removeFollower({ orgId: c.orgId, actorId: c.userA, taskId: c.taskId, userId: c.userB }),
        check: async (c) => { expect(await followerRows(c.taskId)).not.toContain(c.userB) },
      },
      {
        label: 'leaveTask',
        run: (c) => leaveTask({ orgId: c.orgId, actorId: c.userB, taskId: c.taskId }),
        check: async (c) => { expect(await followerRows(c.taskId)).not.toContain(c.userB) },
      },
    ]

    it.each(lockCases)('$label queues on the org structure lock held by another connection, then completes', async ({ label, run, check }) => {
      const { orgId, userA, userB } = ids(`lock_${label}`)
      const userC = `usrC_lock_${randomUUID()}`
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB], completionMode: 'all' })
      await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, userB])
      const ctx: LockCtx = { orgId, userA, userB, userC, taskId: created.id }

      const pool = poolManager.get().getInternalPool()
      const holder = await pool.connect()
      let pending: Promise<unknown> | undefined
      try {
        if (!holder.processID) throw new Error('holder pid missing')
        await holder.query('BEGIN')
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
        const held = await poolManager.get().query<{ classid: number; objid: number }>(
          `SELECT classid, objid FROM pg_locks WHERE locktype = 'advisory' AND pid = $1 AND granted = true AND objsubid = 1`,
          [holder.processID],
        )
        expect(held.rows, label).toHaveLength(1)
        const { classid, objid } = held.rows[0]!

        let settled = false
        pending = run(ctx).finally(() => { settled = true })
        await waitForAdvisoryWaiter(holder.processID, classid, objid, label)
        expect(settled, `${label} must still be waiting on the structure lock`).toBe(false)
        await holder.query('COMMIT')
        await pending
        await check(ctx)
      } finally {
        try { await holder.query('ROLLBACK') } catch { /* already committed */ }
        if (pending) await pending.catch(() => undefined)
        holder.release()
      }
    })

    // The race the lock prevents: an all -> any switch racing a complete.
    // The holder keeps the task row locked so the switch, once it has read
    // the assignee rows, waits on its tasks UPDATE; the complete then has to
    // wait for the switch's structure lock rather than stamp a row the
    // switch has already read as incomplete.
    it('switchCompletionMode(all -> any) racing completeTask keeps the any-mode invariant and done <=> completed_at', async () => {
      const { orgId, userA, userB } = ids('switchvscomplete')
      const created = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB], completionMode: 'all' })
      const pool = poolManager.get().getInternalPool()
      const holder = await pool.connect()
      let pendingSwitch: Promise<unknown> | undefined
      let pendingComplete: Promise<unknown> | undefined
      try {
        if (!holder.processID) throw new Error('holder pid missing')
        await holder.query('BEGIN')
        await holder.query('SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE', [created.id])
        pendingSwitch = switchCompletionMode({ orgId, actorId: userA, taskId: created.id, body: { completionMode: 'any' } })
        await waitForLockWaiters(1, () => false)
        let completeSettled = false
        pendingComplete = completeTask({ orgId, actorId: userA, taskId: created.id }).finally(() => { completeSettled = true })
        // Either the complete is queued (two lock waiters) or it has already
        // finished without waiting.
        await waitForLockWaiters(2, () => completeSettled)
        await holder.query('COMMIT')
        await Promise.all([pendingSwitch, pendingComplete])
      } finally {
        try { await holder.query('ROLLBACK') } catch { /* already committed */ }
        if (pendingSwitch) await pendingSwitch.catch(() => undefined)
        if (pendingComplete) await pendingComplete.catch(() => undefined)
        holder.release()
      }
      await assertAnyModeInvariant(orgId)
      await assertDoneCompletedAtInvariant(orgId)
      expect(await taskRow(created.id)).toMatchObject({ status: 'done', completionMode: 'any', version: 2 })
    })
  })

  // M3R2-TM-8 (R4/R9/R7/X6): detail fields read from the row, not constants.
  describe('detail fields on a nested task after a status flip', () => {
    it('reports parentId, depth and version of the task, and status/completionMode/depth of its children', async () => {
      const { orgId, userA } = ids('detailnested')
      const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
      const mid = await createTask({ orgId, creatorId: userA, title: '中', assignees: [userA] })
      const leaf = await createTask({ orgId, creatorId: userA, title: '叶', assignees: [userA], completionMode: 'any' })
      const server = app()
      const bearerA = await actorBearer(orgId, userA)
      expect((await server.patch(`/api/tasks/${mid.id}/parent`).set('Authorization', `Bearer ${bearerA}`).send({ parentId: root.id })).status).toBe(200)
      expect((await server.patch(`/api/tasks/${leaf.id}/parent`).set('Authorization', `Bearer ${bearerA}`).send({ parentId: mid.id })).status).toBe(200)
      expect((await server.post(`/api/tasks/${leaf.id}/complete`).set('Authorization', `Bearer ${bearerA}`).send({})).status).toBe(200)

      const leafDetail = await server.get(`/api/tasks/${leaf.id}`).set('Authorization', `Bearer ${bearerA}`)
      expect(leafDetail.status).toBe(200)
      expect(leafDetail.body).toMatchObject({ id: leaf.id, parentId: mid.id, depth: 2, version: 2, status: 'done', completionMode: 'any', children: [] })
      const midDetail = await server.get(`/api/tasks/${mid.id}`).set('Authorization', `Bearer ${bearerA}`)
      expect(midDetail.status).toBe(200)
      expect(midDetail.body).toMatchObject({ id: mid.id, parentId: root.id, depth: 1, version: 1 })
      expect(midDetail.body.children).toEqual([{ id: leaf.id, title: '叶', status: 'done', completionMode: 'any', depth: 2 }])
    })
  })

  describe('detail (GET /api/tasks/:id) new M3 fields', () => {
    it('returns followers, ability flags, version, parentId, depth, and visible children', async () => {
      const { orgId, userA, userB } = ids('detail')
      const follower = `usrF_detail_${randomUUID()}`
      const invisibleViewerChild = `usrC_detail_${randomUUID()}`
      const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
      const visibleChild = await createTask({ orgId, creatorId: userA, title: '可见子', assignees: [userB] })
      const invisibleChild = await createTask({ orgId, creatorId: invisibleViewerChild, title: '不可见子', assignees: [invisibleViewerChild] })
      await poolManager.get().query('UPDATE tasks SET parent_id = $2, depth = 1 WHERE id = $1', [visibleChild.id, root.id])
      await poolManager.get().query('UPDATE tasks SET parent_id = $2, depth = 1 WHERE id = $1', [invisibleChild.id, root.id])
      await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [root.id, follower])

      const detail = await getTask({ orgId, actorId: userA, taskId: root.id })
      expect(detail.followers).toEqual([follower])
      expect(detail.canEdit).toBe(true)
      expect(detail.canDelete).toBe(true)
      expect(detail.canComment).toBe(true)
      expect(detail.canLeave).toBe(false)
      expect(detail.version).toBe(1)
      expect(detail.parentId).toBeNull()
      expect(detail.depth).toBe(0)
      const childIds = (detail.children as Array<{ id: string }>).map((c) => c.id)
      expect(childIds).toContain(visibleChild.id)
      // The invisible child is omitted, not turned into a parent 404.
      expect(childIds).not.toContain(invisibleChild.id)

      const asFollower = await getTask({ orgId, actorId: follower, taskId: root.id })
      expect(asFollower.canEdit).toBe(false)
      expect(asFollower.canDelete).toBe(false)
      expect(asFollower.canComment).toBe(true)
      expect(asFollower.canLeave).toBe(true)
    })

    it('a soft-deleted child disappears from `children` even though it was previously visible (M3-AUTHZ-5/M3G-8)', async () => {
      const { orgId, userA } = ids('detailsoftdel')
      const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
      const child = await createTask({ orgId, creatorId: userA, title: '将被软删的子', assignees: [userA] })
      await poolManager.get().query('UPDATE tasks SET parent_id = $2, depth = 1 WHERE id = $1', [child.id, root.id])

      const before = await getTask({ orgId, actorId: userA, taskId: root.id })
      expect((before.children as Array<{ id: string }>).map((c) => c.id)).toContain(child.id)

      const deleted = await deleteTaskById({ orgId, actorId: userA, taskId: child.id })
      expect(deleted).toEqual({ id: child.id, deleted: true })

      const after = await getTask({ orgId, actorId: userA, taskId: root.id })
      expect((after.children as Array<{ id: string }>).map((c) => c.id)).not.toContain(child.id)
      // The parent itself is untouched (still a 200, still has no other children).
      expect(after.children).toEqual([])
    })

    it('a row in another org that points at the task is not listed in `children`, even when the caller can view it (M3G-8 org predicate)', async () => {
      const { orgId, userA } = ids('detailxorg')
      const otherOrg = `${ORG_PREFIX}detailxorg_other_${randomUUID()}`
      const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
      const sameOrgChild = await createTask({ orgId, creatorId: userA, title: '本 org 子', assignees: [userA] })
      const foreignChild = await createTask({ orgId: otherOrg, creatorId: userA, title: '他 org 行', assignees: [userA] })
      // Seeded directly: no API path writes a cross-org parent link, and the
      // schema does not prevent one.
      await poolManager.get().query('UPDATE tasks SET parent_id = $2, depth = 1 WHERE id = ANY($1::text[])', [[sameOrgChild.id, foreignChild.id], root.id])
      const detail = await getTask({ orgId, actorId: userA, taskId: root.id })
      expect((detail.children as Array<{ id: string }>).map((c) => c.id)).toEqual([sameOrgChild.id])
    })
  })
})

/** Waits until a backend queues (granted=false) on the advisory key the
 * holder was granted, and is blocked by the holder. */
async function waitForAdvisoryWaiter(holderPid: number, classid: number, objid: number, label: string): Promise<void> {
  const deadline = Date.now() + 8000
  for (;;) {
    const result = await poolManager.get().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory' AND l.classid = $2 AND l.objid = $3 AND l.objsubid = 1 AND l.granted = false
         AND $1 = ANY (pg_blocking_pids(l.pid))`,
      [holderPid, classid, objid],
    )
    if (Number(result.rows[0]?.n ?? 0) >= 1) return
    if (Date.now() > deadline) throw new Error(`${label}: expected a waiter on the org structure lock`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

/** Waits until at least `min` backends in this database wait on a lock, or
 * `done()` is true. */
async function waitForLockWaiters(min: number, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  for (;;) {
    if (done()) return
    const result = await poolManager.get().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    )
    if (Number(result.rows[0]?.n ?? 0) >= min) return
    if (Date.now() > deadline) throw new Error(`expected ${min} lock waiters`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}
