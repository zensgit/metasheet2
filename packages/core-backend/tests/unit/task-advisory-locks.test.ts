import { describe, expect, it } from 'vitest'
import {
  acquireTaskProjectionLock,
  acquireTaskStructureLock,
  acquireTasksSchedulerLeaderLock,
} from '../../src/db/task-advisory-locks'

describe('task advisory locks', () => {
  it('asks the injected query for the structure key', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    await acquireTaskStructureLock(async (sql, params) => {
      calls.push({ sql, params })
    }, 'org-1')
    expect(calls).toEqual([
      { sql: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: ['task-structure:org-1'] },
    ])
  })

  it('asks the injected query for the projection key', async () => {
    const calls: string[] = []
    await acquireTaskProjectionLock(async (_sql, params) => {
      calls.push(String(params?.[0]))
    }, 'list-1', 'task-1')
    expect(calls).toEqual(['task-projection:list-1:task-1'])
  })

  it('asks the injected query for the scheduler leader key', async () => {
    const calls: string[] = []
    await acquireTasksSchedulerLeaderLock(async (_sql, params) => {
      calls.push(String(params?.[0]))
    })
    expect(calls).toEqual(['tasks-scheduler:leader'])
  })
})
