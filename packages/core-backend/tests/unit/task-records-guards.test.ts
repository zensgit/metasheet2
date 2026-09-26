import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTask } from '../../src/services/task-records'

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
