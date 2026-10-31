/**
 * The todo center's task source reuses the task module's own list and count, reads the organization
 * from the viewer only, and hands over the item fields and nothing else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_PENDING_SOURCE_NAME, taskPendingSource } from '../../src/services/task-pending-source'
import type { PendingViewer } from '../../src/services/pending-source-registry'

const state = vi.hoisted(() => ({
  calls: [] as { sql: string; params?: unknown[] }[],
  rows: [] as Record<string, unknown>[],
}))

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    state.calls.push({ sql, params })
    return { rows: state.rows }
  }),
  transaction: vi.fn(),
}))

const VIEWER: PendingViewer = { actorId: 'u1', roles: [], permissions: [], orgId: 'org-1', timeZone: null }

const ROW = {
  id: 'task-1',
  title: '复核',
  updated_at: new Date('2031-01-02T03:04:05.000Z'),
  due_at: new Date('2031-01-03T00:00:00.000Z'),
  due_date: null,
  due_time: null,
  time_zone: 'Asia/Shanghai',
  description: 'not part of an item',
  created_by: 'someone',
}

describe('task pending source', () => {
  beforeEach(() => {
    state.calls = []
    state.rows = []
  })

  it('declares the read permission of the task routes', () => {
    expect(taskPendingSource.name).toBe(TASK_PENDING_SOURCE_NAME)
    expect(TASK_PENDING_SOURCE_NAME).toBe('task')
    expect(taskPendingSource.permission).toBe('tasks:read')
  })

  it('list runs the task module\'s pending statement with the default page', async () => {
    await taskPendingSource.listPendingForUser(VIEWER)
    expect(state.calls).toHaveLength(1)
    const { sql, params } = state.calls[0]
    expect(sql).toContain('FROM tasks WHERE')
    expect(sql).toContain('EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $1)')
    expect(sql).toContain("tasks.status = 'open'")
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM task_assignees ta_done')
    expect(sql).toContain('ta_done.completed_at IS NOT NULL')
    expect(sql).toContain('ORDER BY tasks.updated_at DESC, tasks.id DESC LIMIT $3 OFFSET $4')
    expect(params).toEqual(['u1', 'org-1', 100, 0])
  })

  it('count runs the unpaged all-open count and never reads the badge setting', async () => {
    state.rows = [{ n: '7' }]
    await expect(taskPendingSource.countPendingForUser?.(VIEWER)).resolves.toBe(7)
    expect(state.calls).toHaveLength(1)
    const { sql, params } = state.calls[0]
    expect(sql).toContain('SELECT count(*)::text')
    expect(sql).toContain("tasks.status = 'open'")
    expect(sql).not.toContain('task_user_settings')
    expect(params).toEqual(['u1', 'org-1'])
  })

  it('a viewer without an organization throws before any query', async () => {
    for (const orgId of [null, undefined, '']) {
      const viewer = { ...VIEWER, orgId }
      await expect(taskPendingSource.listPendingForUser(viewer)).rejects.toThrow('TASK_ORG_MISSING')
      await expect(taskPendingSource.countPendingForUser?.(viewer)).rejects.toThrow('TASK_ORG_MISSING')
    }
    expect(state.calls).toHaveLength(0)
  })

  it('an item holds the item fields and nothing else', async () => {
    state.rows = [ROW]
    const items = await taskPendingSource.listPendingForUser(VIEWER)
    expect(items).toEqual([{
      source: 'task',
      id: 'task-1',
      title: '复核',
      href: '/tasks/task-1',
      updatedAt: '2031-01-02T03:04:05.000Z',
      dueAt: '2031-01-03T00:00:00.000Z',
    }])
  })

  it('a task with no due date has no dueAt key', async () => {
    state.rows = [{ ...ROW, due_at: null }]
    const [item] = await taskPendingSource.listPendingForUser(VIEWER)
    expect(Object.keys(item).sort()).toEqual(['href', 'id', 'source', 'title', 'updatedAt'])
  })

  it('a time zone changes no parameter of the statement', async () => {
    await taskPendingSource.listPendingForUser({ ...VIEWER, timeZone: 'Asia/Shanghai' })
    expect(state.calls[0].params).toEqual(['u1', 'org-1', 100, 0])
    expect(state.calls[0].sql).not.toContain('COALESCE($3')
  })
})
