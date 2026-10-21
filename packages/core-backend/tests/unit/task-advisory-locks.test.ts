import { describe, expect, it, vi } from 'vitest'
import {
  acquireTaskProjectionLock,
  acquireTaskStructureLock,
  acquireTasksSchedulerLeaderLock,
} from '../../src/db/task-advisory-locks'

vi.mock('../../src/tasks/task-lock-keys', () => ({
  taskStructureLockKey: (orgId: string) => `sentinel-structure:${orgId}`,
  taskProjectionLockKey: (listId: string, taskId: string) => `sentinel-projection:${listId}:${taskId}`,
  tasksSchedulerLeaderLockKey: () => 'sentinel-scheduler',
}))

const SQL = 'SELECT pg_advisory_xact_lock(hashtext($1))'

async function capture(
  run: (query: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>,
): Promise<{ sql: string; params?: unknown[] }> {
  let seen: { sql: string; params?: unknown[] } | undefined
  await run(async (sql, params) => {
    seen = { sql, params }
  })
  if (!seen) throw new Error('query was not awaited')
  return seen
}

describe('task advisory locks', () => {
  it('structure lock awaits one-arg xact lock', async () => {
    const seen = await capture((query) => acquireTaskStructureLock(query, 'org-1'))
    expect(seen).toEqual({ sql: SQL, params: ['sentinel-structure:org-1'] })
  })

  it('projection lock awaits one-arg xact lock', async () => {
    const seen = await capture((query) => acquireTaskProjectionLock(query, 'list-1', 'task-1'))
    expect(seen).toEqual({ sql: SQL, params: ['sentinel-projection:list-1:task-1'] })
  })

  it('scheduler lock awaits one-arg xact lock', async () => {
    const seen = await capture((query) => acquireTasksSchedulerLeaderLock(query))
    expect(seen).toEqual({ sql: SQL, params: ['sentinel-scheduler'] })
  })

  it('does not resolve before the query settles (missing await would pass too early)', async () => {
    let settled = false
    const pending = acquireTaskStructureLock(
      () => new Promise((resolve) => {
        setTimeout(() => {
          settled = true
          resolve(undefined)
        }, 20)
      }),
      'org-1',
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    await pending
    expect(settled).toBe(true)
  })

  it('propagates query rejection (a swallowed error would resolve)', async () => {
    await expect(acquireTaskStructureLock(async () => {
      throw new Error('db down')
    }, 'org-1')).rejects.toThrow('db down')
  })
})
