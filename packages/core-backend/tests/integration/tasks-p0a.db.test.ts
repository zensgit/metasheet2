import '../helpers/assert-rbac-optional-off'
import { afterAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createTask, listTasks } from '../../src/services/task-records'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('tasks-p0a.db.test.ts requires EXPECT_DB=1')
}

const orgId = `org_tasks_p0a_${Date.now()}`
const creatorId = `usr_tasks_p0a_${Date.now()}`

describe('tasks P0-A real db', () => {
  afterAll(async () => {
    const pool = poolManager.get()
    await pool.query('DELETE FROM tasks WHERE org_id = $1', [orgId])
  })

  it('creates a task with a tev_ event and lists it for the creator', async () => {
    const created = await createTask({
      orgId,
      creatorId,
      title: '备料复核',
      assignees: undefined,
    })
    expect(created.id.startsWith('tsk_')).toBe(true)
    const events = await poolManager.get().query<{ id: string }>(
      'SELECT id FROM task_events WHERE task_id = $1',
      [created.id],
    )
    expect(events.rows[0]?.id.startsWith('tev_')).toBe(true)
    const rows = await listTasks({ orgId, actorId: creatorId, view: 'created' })
    expect(rows.map((row) => row.id)).toContain(created.id)
  })
})
