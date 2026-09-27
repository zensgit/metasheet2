import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completeTask, createTask, reopenTask, toTaskPendingItem } from '../../src/services/task-records'

const state = vi.hoisted(() => ({
  calls: [] as { sql: string; params?: unknown[] }[],
  transactions: 0,
}))

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(async (handler: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: [] }> }) => Promise<unknown>) => {
    state.transactions += 1
    return handler({
      query: async (sql: string, params?: unknown[]) => {
        state.calls.push({ sql, params })
        return { rows: [] }
      },
    })
  }),
}))

function insertedTitle(): unknown {
  const insert = state.calls.find((call) => call.sql.includes('INSERT INTO tasks'))
  return insert?.params?.[2]
}

function insertedMode(): unknown {
  const insert = state.calls.find((call) => call.sql.includes('INSERT INTO tasks'))
  return insert?.params?.[3]
}

describe('createTask guards', () => {
  beforeEach(() => {
    state.calls.length = 0
    state.transactions = 0
  })

  it('rejects gate 10 blank titles before opening a transaction', async () => {
    const blanks = ['\t', '  \n ', '\u3000', '\u200B\u200C\u200D\uFEFF', '', 42]
    for (const title of blanks) {
      state.transactions = 0
      await expect(createTask({
        orgId: 'org-1',
        creatorId: 'usr-1',
        title,
        assignees: undefined,
      })).rejects.toMatchObject({ status: 422, code: 'INVALID_TITLE' })
      expect(state.transactions).toBe(0)
    }
  })

  it('stores NFC-trimmed titles and keeps an explicit any mode', async () => {
    const created = await createTask({
      orgId: 'org-1',
      creatorId: 'usr-1',
      title: '  备料复核  ',
      assignees: undefined,
      completionMode: 'any',
    })
    expect(created.id.startsWith('tsk_')).toBe(true)
    expect(state.calls[0]?.sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(insertedTitle()).toBe('备料复核')
    expect(insertedMode()).toBe('any')

    state.calls.length = 0
    await createTask({
      orgId: 'org-1',
      creatorId: 'usr-1',
      title: 'e\u0301',
      assignees: [],
    })
    expect(insertedTitle()).toBe('é')
    expect(insertedMode()).toBe('all')
  })

  it('rejects an illegal completion mode instead of storing all', async () => {
    await expect(createTask({
      orgId: 'org-1',
      creatorId: 'usr-1',
      title: '备料复核',
      assignees: undefined,
      completionMode: 'nope',
    })).rejects.toMatchObject({ status: 422, code: 'INVALID_MODE' })
    expect(state.transactions).toBe(0)
  })
})

describe('structure-lock isolation', () => {
  beforeEach(() => {
    state.calls.length = 0
    state.transactions = 0
  })

  it('starts complete with READ COMMITTED before any other statement', async () => {
    await expect(completeTask({
      orgId: 'org-1',
      actorId: 'usr-1',
      taskId: 'tsk_missing',
    })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(state.calls[0]?.sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(state.transactions).toBe(1)
  })

  it('starts reopen with READ COMMITTED before any other statement', async () => {
    await expect(reopenTask({
      orgId: 'org-1',
      actorId: 'usr-1',
      taskId: 'tsk_missing',
      scope: 'all',
    })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(state.calls[0]?.sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(state.transactions).toBe(1)
  })
})

describe('pending items', () => {
  it('omits dueAt when the task has no due date and keeps the five keys', () => {
    expect(toTaskPendingItem({
      id: 'tsk_a',
      title: '备料复核',
      updated_at: new Date('2026-09-27T00:00:00.000Z'),
      due_at: null,
    })).toEqual({
      source: 'task',
      id: 'tsk_a',
      title: '备料复核',
      href: '/tasks/tsk_a',
      updatedAt: '2026-09-27T00:00:00.000Z',
    })
  })

  it('adds dueAt only when a due instant exists', () => {
    const item = toTaskPendingItem({
      id: 'tsk_b',
      title: '备料复核',
      updated_at: new Date('2026-09-27T00:00:00.000Z'),
      due_at: new Date('2026-09-28T01:02:03.000Z'),
    })
    expect(item.dueAt).toBe('2026-09-28T01:02:03.000Z')
    expect(Object.keys(item).sort()).toEqual(['dueAt', 'href', 'id', 'source', 'title', 'updatedAt'])
  })

  it('reads an all-day due_date string in the task time zone, not as a Date', () => {
    const item = toTaskPendingItem({
      id: 'tsk_c',
      title: '备料复核',
      updated_at: new Date('2026-09-27T00:00:00.000Z'),
      due_at: null,
      due_date: '2026-09-28',
      due_time: null,
      time_zone: 'Asia/Shanghai',
    })
    expect(item.dueAt).toBe('2026-09-28T15:59:59.999Z')
  })
})
