import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { completeTask, createTask } from '../../src/services/task-records'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-completion-grid.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_g3_'

async function statusOf(id: string): Promise<string> {
  const result = await poolManager.get().query<{ status: string }>(
    'SELECT status FROM tasks WHERE id = $1',
    [id],
  )
  return result.rows[0]?.status ?? ''
}

async function assigneeCount(id: string): Promise<string> {
  const result = await poolManager.get().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM task_assignees WHERE task_id = $1',
    [id],
  )
  return result.rows[0]?.n ?? '0'
}

describe('gate 3 surviving completion cells', () => {
  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', [`${ORG_PREFIX}%`])
  })

  it('all x 0: an explicit empty assignee list stays empty and the creator complete marks done', async () => {
    const stamp = randomUUID()
    const orgId = `${ORG_PREFIX}all0_${stamp}`
    const creator = `usr_${stamp}`
    const created = await createTask({ orgId, creatorId: creator, title: '备料复核', assignees: [], completionMode: 'all' })
    expect(await assigneeCount(created.id)).toBe('0')
    await completeTask({ orgId, actorId: creator, taskId: created.id })
    expect(await statusOf(created.id)).toBe('done')
  })

  it('any x 0: an explicit empty assignee list stays empty and the creator complete marks done', async () => {
    const stamp = randomUUID()
    const orgId = `${ORG_PREFIX}any0_${stamp}`
    const creator = `usr_${stamp}`
    const created = await createTask({ orgId, creatorId: creator, title: '备料复核', assignees: [], completionMode: 'any' })
    expect(await assigneeCount(created.id)).toBe('0')
    await completeTask({ orgId, actorId: creator, taskId: created.id })
    expect(await statusOf(created.id)).toBe('done')
  })

  it('all x 1: omitting assignees inserts the creator, and that row completes the task', async () => {
    const stamp = randomUUID()
    const orgId = `${ORG_PREFIX}all1_${stamp}`
    const creator = `usr_${stamp}`
    const created = await createTask({ orgId, creatorId: creator, title: '备料复核', completionMode: 'all' })
    expect(await assigneeCount(created.id)).toBe('1')
    const who = await poolManager.get().query<{ user_id: string }>(
      'SELECT user_id FROM task_assignees WHERE task_id = $1',
      [created.id],
    )
    expect(who.rows[0]?.user_id).toBe(creator)
    await completeTask({ orgId, actorId: creator, taskId: created.id })
    expect(await statusOf(created.id)).toBe('done')
  })

  it('any x 1: omitting assignees inserts the creator, and that row completes the task', async () => {
    const stamp = randomUUID()
    const orgId = `${ORG_PREFIX}any1_${stamp}`
    const creator = `usr_${stamp}`
    const created = await createTask({ orgId, creatorId: creator, title: '备料复核', completionMode: 'any' })
    expect(await assigneeCount(created.id)).toBe('1')
    await completeTask({ orgId, actorId: creator, taskId: created.id })
    expect(await statusOf(created.id)).toBe('done')
  })

  it('all x n: one of two assignees does not finish the task', async () => {
    const stamp = randomUUID()
    const orgId = `${ORG_PREFIX}alln_${stamp}`
    const creator = `usrC_${stamp}`
    const a = `usrA_${stamp}`
    const b = `usrB_${stamp}`
    const created = await createTask({
      orgId, creatorId: creator, title: '备料复核', assignees: [a, b], completionMode: 'all',
    })
    expect(await assigneeCount(created.id)).toBe('2')
    await completeTask({ orgId, actorId: a, taskId: created.id })
    expect(await statusOf(created.id)).toBe('open')
    await completeTask({ orgId, actorId: b, taskId: created.id })
    expect(await statusOf(created.id)).toBe('done')
  })

  it('any x n: one of two assignees finishes the task', async () => {
    const stamp = randomUUID()
    const orgId = `${ORG_PREFIX}anyn_${stamp}`
    const creator = `usrC_${stamp}`
    const a = `usrA_${stamp}`
    const b = `usrB_${stamp}`
    const created = await createTask({
      orgId, creatorId: creator, title: '备料复核', assignees: [a, b], completionMode: 'any',
    })
    expect(await assigneeCount(created.id)).toBe('2')
    await completeTask({ orgId, actorId: a, taskId: created.id })
    expect(await statusOf(created.id)).toBe('done')
  })
})
