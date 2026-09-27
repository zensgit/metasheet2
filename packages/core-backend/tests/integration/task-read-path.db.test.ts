import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { completeTask, countPending, createTask, listPending, listTasks } from '../../src/services/task-records'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-read-path.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_read_'

function ids(label: string): { orgId: string; creator: string; me: string; other: string } {
  const stamp = randomUUID()
  return {
    orgId: `${ORG_PREFIX}${label}_${stamp}`,
    creator: `usrC_${label}_${stamp}`,
    me: `usrM_${label}_${stamp}`,
    other: `usrO_${label}_${stamp}`,
  }
}

async function seedPastDue(taskId: string): Promise<void> {
  await poolManager.get().query(
    `UPDATE tasks
     SET due_date = ((now() AT TIME ZONE 'UTC')::date - 1),
         due_time = TIME '12:00',
         due_at = now() - interval '2 hours',
         time_zone = 'UTC'
     WHERE id = $1`,
    [taskId],
  )
}

describe('tasks read path', () => {
  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', [`${ORG_PREFIX}%`])
  })

  it('gate 4 negative: a completed assignee stays in assigned and leaves pending and the overdue count', async () => {
    const { orgId, creator, me, other } = ids('g4neg')
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me, other],
      completionMode: 'all',
    })
    const counted = await poolManager.get().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM task_assignees WHERE task_id = $1',
      [created.id],
    )
    expect(counted.rows[0]?.n).toBe('2')
    await seedPastDue(created.id)
    await completeTask({ orgId, actorId: me, taskId: created.id })

    const assigned = await listTasks({ orgId, actorId: me, view: 'assigned' })
    expect(assigned.map((row) => row.id)).toContain(created.id)
    const pending = await listPending({ orgId, actorId: me, viewerTz: null })
    expect(pending.map((row) => row.id)).not.toContain(created.id)
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(0)
  })

  it('gate 4 positive: an overdue open assignment is pending and counts as 1', async () => {
    const { orgId, creator, me, other } = ids('g4pos')
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me, other],
      completionMode: 'all',
    })
    await seedPastDue(created.id)

    const pending = await listPending({ orgId, actorId: me, viewerTz: null })
    expect(pending.map((row) => row.id)).toEqual([created.id])
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(1)
  })

  it('keeps an undated open assignment on the pending list and out of the overdue count', async () => {
    // Lock §13-4: /pending passes all_open; /pending-count uses default badge_scope overdue.
    // Gate 4's two cells are both already overdue, so they do not collapse those parameters.
    const { orgId, creator, me } = ids('split')
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me],
      completionMode: 'all',
    })

    const pending = await listPending({ orgId, actorId: me, viewerTz: null })
    expect(pending.map((row) => row.id)).toEqual([created.id])
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(0)
  })
})
