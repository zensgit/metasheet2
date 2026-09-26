import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { completeTask, createTask, listTasks, reopenTask } from '../../src/services/task-records'
import { taskStructureLockKey } from '../../src/tasks/task-lock-keys'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-p0a.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_p0a_'

function ids(label: string): { orgId: string; userA: string; userB: string; outsider: string } {
  const stamp = randomUUID()
  return {
    orgId: `${ORG_PREFIX}${label}_${stamp}`,
    userA: `usrA_${label}_${stamp}`,
    userB: `usrB_${label}_${stamp}`,
    outsider: `usrO_${label}_${stamp}`,
  }
}

async function taskRow(taskId: string): Promise<{ status: string; version: number; title?: string }> {
  const result = await poolManager.get().query<{ status: string; version: number; title: string }>(
    'SELECT status, version, title FROM tasks WHERE id = $1',
    [taskId],
  )
  const row = result.rows[0]
  if (!row) throw new Error('task missing')
  return { status: row.status, version: Number(row.version), title: row.title }
}

async function assigneeRows(taskId: string): Promise<Array<{ user_id: string; completed_at: Date | null; xmin: string }>> {
  const result = await poolManager.get().query<{ user_id: string; completed_at: Date | null; xmin: string }>(
    'SELECT user_id, completed_at, xmin::text AS xmin FROM task_assignees WHERE task_id = $1 ORDER BY user_id',
    [taskId],
  )
  return result.rows
}

describe('tasks P0-A real db', () => {
  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', [`${ORG_PREFIX}%`])
  })

  it('creates a task with a tev_ event and lists it for the creator', async () => {
    const { orgId, userA } = ids('list')
    const created = await createTask({
      orgId,
      creatorId: userA,
      title: '备料复核',
      assignees: undefined,
    })
    expect(created.id.startsWith('tsk_')).toBe(true)
    const events = await poolManager.get().query<{ id: string }>(
      'SELECT id FROM task_events WHERE task_id = $1',
      [created.id],
    )
    expect(events.rows[0]?.id.startsWith('tev_')).toBe(true)
    const rows = await listTasks({ orgId, actorId: userA, view: 'created' })
    expect(rows.map((row) => row.id)).toContain(created.id)
  })

  it('stores a trimmed title and holds the structure lock during insert', async () => {
    const { orgId, userA } = ids('title')
    const pool = poolManager.get()
    await pool.query('DROP TRIGGER IF EXISTS tasks_p0a_assert_structure_lock ON tasks')
    await pool.query('DROP FUNCTION IF EXISTS tasks_p0a_assert_structure_lock()')
    await pool.query(`
      CREATE FUNCTION tasks_p0a_assert_structure_lock()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
        ) THEN
          RAISE EXCEPTION 'structure lock not held';
        END IF;
        RETURN NEW;
      END
      $fn$
    `)
    await pool.query(`
      CREATE TRIGGER tasks_p0a_assert_structure_lock
      BEFORE INSERT ON tasks
      FOR EACH ROW
      EXECUTE FUNCTION tasks_p0a_assert_structure_lock()
    `)
    try {
      const created = await createTask({
        orgId,
        creatorId: userA,
        title: '  备料复核  ',
        assignees: undefined,
      })
      const row = await taskRow(created.id)
      expect(row.title).toBe('备料复核')
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS tasks_p0a_assert_structure_lock ON tasks')
      await pool.query('DROP FUNCTION IF EXISTS tasks_p0a_assert_structure_lock()')
    }
  })

  it('reopen clears only the actor and does not bump version until status changes', async () => {
    const { orgId, userA, userB } = ids('reopen')
    const created = await createTask({
      orgId,
      creatorId: userA,
      title: '备料复核',
      assignees: [userA, userB],
      completionMode: 'all',
    })
    const before = await assigneeRows(created.id)
    const xminB = before.find((row) => row.user_id === userB)?.xmin
    await completeTask({ orgId, actorId: userA, taskId: created.id })
    const afterA = await assigneeRows(created.id)
    expect(afterA.find((row) => row.user_id === userA)?.completed_at).toBeTruthy()
    expect(afterA.find((row) => row.user_id === userB)?.completed_at).toBeNull()
    expect(afterA.find((row) => row.user_id === userB)?.xmin).toBe(xminB)
    expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })

    await completeTask({ orgId, actorId: userB, taskId: created.id })
    const done = await taskRow(created.id)
    expect(done).toMatchObject({ status: 'done', version: 2 })
    const stamped = await assigneeRows(created.id)
    const rowB = stamped.find((row) => row.user_id === userB)
    expect(rowB?.completed_at).toBeTruthy()

    await reopenTask({ orgId, actorId: userA, taskId: created.id, scope: 'self' })
    const reopened = await assigneeRows(created.id)
    expect(reopened.find((row) => row.user_id === userA)?.completed_at).toBeNull()
    const kept = reopened.find((row) => row.user_id === userB)
    expect(kept?.completed_at?.toISOString()).toBe(rowB?.completed_at?.toISOString())
    expect(kept?.xmin).toBe(rowB?.xmin)
    expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 3 })
    const events = await poolManager.get().query<{ event_type: string }>(
      `SELECT event_type FROM task_events WHERE task_id = $1 AND event_type = 'self_reopened'`,
      [created.id],
    )
    expect(events.rows).toHaveLength(1)
  })

  it('serializes two completes that start while the structure lock is held', async () => {
    const { orgId, userA, userB } = ids('race')
    const created = await createTask({
      orgId,
      creatorId: userA,
      title: '备料复核',
      assignees: [userA, userB],
      completionMode: 'all',
    })
    const pool = poolManager.get().getInternalPool()
    const holder = await pool.connect()
    let pending: Promise<unknown> | undefined
    let stopWaiting = false
    try {
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
      pending = Promise.all([
        completeTask({ orgId, actorId: userA, taskId: created.id }),
        completeTask({ orgId, actorId: userB, taskId: created.id }),
      ])
      const outcome = await Promise.race([
        waitUntilBlocked(holder.processID, 2, () => stopWaiting).then(() => 'waiting' as const),
        pending.then(() => 'finished' as const),
      ])
      expect(outcome).toBe('waiting')
      await holder.query('COMMIT')
      await pending
    } finally {
      stopWaiting = true
      try {
        await holder.query('ROLLBACK')
      } catch {
        // The holder transaction was already committed.
      }
      if (pending) await pending.catch(() => undefined)
      holder.release()
    }
    const rows = await assigneeRows(created.id)
    expect(rows.every((row) => row.completed_at !== null)).toBe(true)
    expect(await taskRow(created.id)).toMatchObject({ status: 'done', version: 2 })
    const events = await poolManager.get().query<{ event_type: string }>(
      `SELECT event_type FROM task_events
       WHERE task_id = $1 AND event_type IN ('self_completed', 'completed')
       ORDER BY event_type`,
      [created.id],
    )
    expect(events.rows.map((row) => row.event_type)).toEqual(['completed', 'self_completed'])
  })

  it('hides complete and reopen from a follower, an outsider, and another org', async () => {
    const { orgId, userA, outsider } = ids('guard')
    const follower = `usrF_guard_${randomUUID()}`
    const created = await createTask({
      orgId,
      creatorId: userA,
      title: '备料复核',
      assignees: [userA],
    })
    await poolManager.get().query(
      'INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)',
      [created.id, follower],
    )
    await expect(completeTask({ orgId, actorId: follower, taskId: created.id })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    await expect(reopenTask({ orgId, actorId: follower, taskId: created.id, scope: 'self' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    await expect(completeTask({ orgId, actorId: outsider, taskId: created.id })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    await expect(reopenTask({ orgId, actorId: outsider, taskId: created.id, scope: 'self' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    const otherOrg = `${ORG_PREFIX}other_${randomUUID()}`
    await expect(completeTask({ orgId: otherOrg, actorId: userA, taskId: created.id })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    await expect(reopenTask({ orgId: otherOrg, actorId: userA, taskId: created.id, scope: 'self' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })
  })

  it('does not bump version when reopen leaves the task open', async () => {
    const { orgId, userA, userB } = ids('noop')
    const created = await createTask({
      orgId,
      creatorId: userA,
      title: '备料复核',
      assignees: [userA, userB],
      completionMode: 'all',
    })
    await completeTask({ orgId, actorId: userA, taskId: created.id })
    expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })
    await reopenTask({ orgId, actorId: userA, taskId: created.id, scope: 'self' })
    const rows = await assigneeRows(created.id)
    expect(rows.find((row) => row.user_id === userA)?.completed_at).toBeNull()
    expect(rows.find((row) => row.user_id === userB)?.completed_at).toBeNull()
    expect(await taskRow(created.id)).toMatchObject({ status: 'open', version: 1 })
  })

  it('queues complete before reopen so an all-mode task stays open', async () => {
    const { orgId, userA, userB } = ids('reopen-race')
    const created = await createTask({
      orgId,
      creatorId: userA,
      title: '备料复核',
      assignees: [userA, userB],
      completionMode: 'all',
    })
    await completeTask({ orgId, actorId: userA, taskId: created.id })
    const pool = poolManager.get().getInternalPool()
    const holder = await pool.connect()
    let completePending: Promise<unknown> | undefined
    let reopenPending: Promise<unknown> | undefined
    let stopWaiting = false
    try {
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
      completePending = completeTask({ orgId, actorId: userB, taskId: created.id })
      await waitUntilBlocked(holder.processID, 1, () => stopWaiting)
      reopenPending = reopenTask({ orgId, actorId: userA, taskId: created.id, scope: 'self' })
      await waitUntilBlocked(holder.processID, 2, () => stopWaiting)
      await holder.query('COMMIT')
      await completePending
      await reopenPending
    } finally {
      stopWaiting = true
      try {
        await holder.query('ROLLBACK')
      } catch {
        // The holder transaction was already committed.
      }
      if (completePending) await completePending.catch(() => undefined)
      if (reopenPending) await reopenPending.catch(() => undefined)
      holder.release()
    }
    const rows = await assigneeRows(created.id)
    expect(rows.find((row) => row.user_id === userA)?.completed_at).toBeNull()
    expect(rows.find((row) => row.user_id === userB)?.completed_at).toBeTruthy()
    expect((await taskRow(created.id)).status).toBe('open')
  })

  it('queues complete before reopen-all so both assignee rows are cleared', async () => {
    const { orgId, userA, userB } = ids('reopen-all')
    const created = await createTask({
      orgId,
      creatorId: userA,
      title: '备料复核',
      assignees: [userA, userB],
      completionMode: 'all',
    })
    await completeTask({ orgId, actorId: userA, taskId: created.id })
    const pool = poolManager.get().getInternalPool()
    const holder = await pool.connect()
    let completePending: Promise<unknown> | undefined
    let reopenPending: Promise<unknown> | undefined
    let stopWaiting = false
    try {
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
      completePending = completeTask({ orgId, actorId: userB, taskId: created.id })
      await waitUntilBlocked(holder.processID, 1, () => stopWaiting)
      reopenPending = reopenTask({ orgId, actorId: userA, taskId: created.id, scope: 'all' })
      await waitUntilBlocked(holder.processID, 2, () => stopWaiting)
      await holder.query('COMMIT')
      await completePending
      await reopenPending
    } finally {
      stopWaiting = true
      try {
        await holder.query('ROLLBACK')
      } catch {
        // The holder transaction was already committed.
      }
      if (completePending) await completePending.catch(() => undefined)
      if (reopenPending) await reopenPending.catch(() => undefined)
      holder.release()
    }
    const rows = await assigneeRows(created.id)
    expect(rows.find((row) => row.user_id === userA)?.completed_at).toBeNull()
    expect(rows.find((row) => row.user_id === userB)?.completed_at).toBeNull()
  })
})

async function waitUntilBlocked(holderPid: number, min: number, stopped: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  for (;;) {
    if (stopped()) return
    const result = await poolManager.get().query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND $1 = ANY (pg_blocking_pids(pid))`,
      [holderPid],
    )
    if (stopped()) return
    if (Number(result.rows[0]?.n ?? 0) >= min) return
    if (Date.now() > deadline) throw new Error(`expected ${min} backends blocked by ${holderPid}`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}
