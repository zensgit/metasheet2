import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../../src/db/pg'
import { patchTask } from '../../src/services/task-patch'
import {
  addTaskListMember,
  addTaskToList,
  changeTaskListMemberRole,
  createTaskList,
  getTaskList,
  listTaskListEvents,
  listTaskListItems,
  listTaskListMembers,
  removeTaskFromList,
  removeTaskListMember,
  renameTaskList,
  setTaskListArchived,
  transferTaskListOwner,
} from '../../src/services/task-list-records'
import { completeTask, countPending, createTask, parseTaskPage, reopenTask, toTaskPendingItem } from '../../src/services/task-records'
import { addAssignee, addFollower, leaveTask, removeAssignee, removeFollower } from '../../src/services/task-structure'
import {
  createTaskListGroup,
  createUserTaskGroup,
  deleteTaskListGroup,
  deleteUserTaskGroup,
  listTaskListGroupItems,
  listTaskListGroups,
  listUserTaskGroupItems,
  listUserTaskGroups,
  placeTaskInListGroup,
  placeTaskInUserGroup,
  renameTaskListGroup,
  renameUserTaskGroup,
} from '../../src/services/task-group-records'

type MockRows = { rows: Record<string, unknown>[] }

const state = vi.hoisted(() => ({
  calls: [] as { sql: string; params?: unknown[] }[],
  transactions: 0,
  /** Optional per-statement answer inside a transaction; `undefined` keeps the empty row set. */
  respond: undefined as undefined | ((sql: string, params?: unknown[]) => { rows: Record<string, unknown>[] } | undefined),
}))

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(async (handler: (client: { query: (sql: string, params?: unknown[]) => Promise<MockRows> }) => Promise<unknown>) => {
    state.transactions += 1
    return handler({
      query: async (sql: string, params?: unknown[]) => {
        state.calls.push({ sql, params })
        return state.respond?.(sql, params) ?? { rows: [] }
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

// M4 PR-3a S4 (design §5.1, §5.2, §4.2). RULED(2026-10-07): [R03] the date keys, `timeZone`
// and `remindAt` are checked before the transaction opens; the first five binds keep their places.
describe('createTask dates (M4 PR-3a)', () => {
  beforeEach(() => {
    state.calls.length = 0
    state.transactions = 0
  })

  const base = { orgId: 'org-1', creatorId: 'usr-1', title: '备料复核', assignees: undefined }

  it.each([
    ["dueTime ''", 'INVALID_DATE', { dueDate: '2026-09-30', dueTime: '', timeZone: 'Asia/Shanghai' }],
    ['dueTime 0', 'INVALID_DATE', { dueDate: '2026-09-30', dueTime: 0, timeZone: 'Asia/Shanghai' }],
    ['dueTime false', 'INVALID_DATE', { dueDate: '2026-09-30', dueTime: false, timeZone: 'Asia/Shanghai' }],
    ['dueDate array', 'INVALID_DATE', { dueDate: ['2026-09-30'], timeZone: 'Asia/Shanghai' }],
    ['dueDate number', 'INVALID_DATE', { dueDate: 20260930, timeZone: 'Asia/Shanghai' }],
    ['dueDate object', 'INVALID_DATE', { dueDate: {}, timeZone: 'Asia/Shanghai' }],
    ['2026-02-30', 'INVALID_DATE', { dueDate: '2026-02-30', timeZone: 'Asia/Shanghai' }],
    ['time without date', 'INVALID_DATE', { dueTime: '10:00', timeZone: 'Asia/Shanghai' }],
    ['date without zone', 'TIME_ZONE_REQUIRED', { dueDate: '2026-09-30' }],
    ['unknown zone', 'INVALID_TIME_ZONE', { dueDate: '2026-09-30', timeZone: 'Not/AZone' }],
    ['zone number', 'INVALID_TIME_ZONE', { timeZone: 8 }],
    ['remindAt without zone', 'INVALID_REMIND_AT', { remindAt: '2026-09-30T10:00:00' }],
    ['remindAt number', 'INVALID_REMIND_AT', { remindAt: 5 }],
  ])('%s is 422 %s with no transaction opened', async (_label, code, extra) => {
    await expect(createTask({ ...base, ...extra })).rejects.toMatchObject({ status: 422, code })
    expect(state.transactions).toBe(0)
    expect(state.calls).toHaveLength(0)
  })

  it('a dated create still starts with READ COMMITTED, reads the creator policy after the lock, and binds canonical values after the first five', async () => {
    const created = await createTask({
      ...base, completionMode: 'any', dueDate: '2026-09-30', dueTime: '10:00', timeZone: 'asia/shanghai',
    })
    expect(created.id.startsWith('tsk_')).toBe(true)
    expect(created.version).toBe(1)
    expect(state.transactions).toBe(1)
    expect(state.calls[0]?.sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    const lockAt = state.calls.findIndex((call) => call.sql.includes('pg_advisory_xact_lock'))
    const policyAt = state.calls.findIndex((call) => call.sql.includes('FROM task_user_settings'))
    const insertAt = state.calls.findIndex((call) => call.sql.includes('INSERT INTO tasks'))
    expect(lockAt).toBeGreaterThan(0)
    expect(policyAt).toBeGreaterThan(lockAt)
    expect(insertAt).toBeGreaterThan(policyAt)
    expect(state.calls[policyAt]?.params).toEqual(['usr-1', 'org-1'])
    const params = state.calls[insertAt]?.params ?? []
    expect(params.slice(1, 5)).toEqual(['org-1', '备料复核', 'any', 'usr-1'])
    expect(insertedTitle()).toBe('备料复核')
    expect(insertedMode()).toBe('any')
    // No settings row in this mock: the default policy, thirty minutes before due_at.
    expect(params.slice(5)).toEqual([
      '2026-09-30', '10:00:00', null, null, 'Asia/Shanghai', '2026-09-30T02:00:00.000Z', '2026-09-30T01:30:00.000Z',
    ])
  })

  it('a create without dates never reads the settings table and binds seven nulls', async () => {
    await createTask({ ...base })
    expect(state.calls.some((call) => call.sql.includes('task_user_settings'))).toBe(false)
    const insert = state.calls.find((call) => call.sql.includes('INSERT INTO tasks'))
    expect(insert?.params?.slice(5)).toEqual([null, null, null, null, null, null, null])
  })

  it('an explicit remindAt (null or an instant) skips the settings read', async () => {
    await createTask({ ...base, dueDate: '2026-09-30', timeZone: 'UTC', remindAt: null })
    await createTask({ ...base, dueDate: '2026-09-30', timeZone: 'UTC', remindAt: '2020-01-01T00:00:00+08:00' })
    expect(state.calls.some((call) => call.sql.includes('task_user_settings'))).toBe(false)
    const inserts = state.calls.filter((call) => call.sql.includes('INSERT INTO tasks'))
    expect(inserts.map((call) => call.params?.[11])).toEqual([null, '2019-12-31T16:00:00.000Z'])
  })
})

describe('structure-lock isolation', () => {
  beforeEach(() => {
    state.calls.length = 0
    state.transactions = 0
  })

  it('starts PATCH with READ COMMITTED before any other statement; a missing task is 404 before the body is looked at', async () => {
    await expect(patchTask({
      orgId: 'org-1',
      actorId: 'usr-1',
      taskId: 'tsk_missing',
      body: { expectedVersion: 'not-a-number', title: null },
    })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(state.calls[0]?.sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(state.transactions).toBe(1)
    expect(state.calls.some((call) => /^\s*(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it('PATCH with a non-printable task id is 404 and sends no statement that carries the id', async () => {
    for (const taskId of ['tsk_\u0000', 'tsk a', '备料', '']) {
      state.calls.length = 0
      await expect(patchTask({ orgId: 'org-1', actorId: 'usr-1', taskId, body: { expectedVersion: 1 } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(state.calls.some((call) => (call.params ?? []).includes(taskId))).toBe(false)
    }
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

describe('countPending badge scope (M4 PR-3a)', () => {
  const mockedQuery = vi.mocked(query)

  beforeEach(() => {
    mockedQuery.mockReset()
  })

  it("badge_scope 'off' returns null after reading only the settings row; no query touches tasks", async () => {
    mockedQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM task_user_settings')) return { rows: [{ badge_scope: 'off' }] } as never
      return { rows: [{ n: '7' }] } as never
    })
    expect(await countPending({ orgId: 'org-1', actorId: 'usr-1', viewerTz: null })).toBeNull()
    const statements = mockedQuery.mock.calls.map((call) => String(call[0]))
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('FROM task_user_settings')
    expect(statements.some((sql) => /\bFROM tasks\b/.test(sql))).toBe(false)
  })

  it('no settings row counts with the overdue scope', async () => {
    mockedQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM task_user_settings')) return { rows: [] } as never
      return { rows: [{ n: '3' }] } as never
    })
    expect(await countPending({ orgId: 'org-1', actorId: 'usr-1', viewerTz: 'UTC' })).toBe(3)
    const count = mockedQuery.mock.calls.map((call) => String(call[0])).find((sql) => /\bFROM tasks\b/.test(sql))
    expect(count).toContain('tasks.due_date < (now() AT TIME ZONE')
    expect(count).not.toContain('+ 1)::timestamp')
  })
})

describe('parseTaskPage (M4 PR-3a)', () => {
  it('defaults to limit 100, offset 0', () => {
    expect(parseTaskPage({})).toEqual({ limit: 100, offset: 0 })
  })

  it('maps the pure reason to the 422 code', () => {
    expect(() => parseTaskPage({ limit: '0' })).toThrow(expect.objectContaining({ status: 422, code: 'INVALID_LIMIT' }))
    expect(() => parseTaskPage({ offset: '-1' })).toThrow(expect.objectContaining({ status: 422, code: 'INVALID_OFFSET' }))
  })
})

describe('task lists (M4 PR-3a S5)', () => {
  beforeEach(() => {
    state.calls.length = 0
    state.transactions = 0
    vi.mocked(query).mockClear()
  })

  it('createTaskList rejects an invalid name before opening a transaction', async () => {
    for (const [body, code] of [
      [{}, 'INVALID_NAME'],
      [{ name: '  ' }, 'INVALID_NAME'],
      [{ name: 'a\u0000b' }, 'INVALID_NAME'],
      [{ name: 'a\uD800' }, 'INVALID_NAME'],
      [[{ name: 'a' }], 'INVALID_NAME'],
      [{ name: 'x'.repeat(101) }, 'NAME_TOO_LONG'],
    ] as const) {
      state.transactions = 0
      await expect(createTaskList({ orgId: 'org-1', actorId: 'usr-1', body })).rejects.toMatchObject({ status: 422, code })
      expect(state.transactions).toBe(0)
      expect(state.calls).toHaveLength(0)
    }
  })

  it('createTaskList: READ COMMITTED, the structure lock, then list, owner row, default group and event, in that order', async () => {
    // The mock returns no rows, so the final read-back is 404; the statement order is the point.
    await expect(createTaskList({ orgId: 'org-1', actorId: 'usr-1', body: { name: '  备料  ' } })).rejects.toMatchObject({ status: 404 })
    expect(state.transactions).toBe(1)
    const sqls = state.calls.map((call) => call.sql.replace(/\s+/g, ' ').trim())
    expect(sqls[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(sqls[1]).toContain('pg_advisory_xact_lock')
    expect(sqls[2]).toMatch(/^INSERT INTO task_lists /)
    expect(state.calls[2].params?.[2]).toBe('备料')
    expect(state.calls[2].params?.[3]).toBe('usr-1')
    expect(sqls[3]).toMatch(/^INSERT INTO task_list_members .*'owner'/)
    expect(sqls[4]).toMatch(/^INSERT INTO task_groups .*'list'.*true/)
    expect(sqls[5]).toMatch(/^INSERT INTO task_list_events /)
    expect(state.calls[5].params?.[3]).toBe('created')
  })

  it('list writes start with READ COMMITTED; a missing list is 404 before the body is looked at, nothing written', async () => {
    const writes = [
      () => renameTaskList({ orgId: 'org-1', actorId: 'usr-1', listId: 'tlst_missing', body: { name: '' } }),
      () => setTaskListArchived({ orgId: 'org-1', actorId: 'usr-1', listId: 'tlst_missing', archived: true }),
      () => setTaskListArchived({ orgId: 'org-1', actorId: 'usr-1', listId: 'tlst_missing', archived: false }),
    ]
    for (const write of writes) {
      state.calls.length = 0
      await expect(write()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(state.calls[0]?.sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      expect(state.calls.some((call) => /^\s*(UPDATE|INSERT)/.test(call.sql))).toBe(false)
    }
  })

  it('a list id that cannot be stored is 404 and no statement carries it', async () => {
    for (const listId of ['tlst_\u0000', 'tlst a', '清单', '']) {
      state.calls.length = 0
      vi.mocked(query).mockClear()
      const calls = [
        renameTaskList({ orgId: 'org-1', actorId: 'usr-1', listId, body: { name: 'n' } }),
        setTaskListArchived({ orgId: 'org-1', actorId: 'usr-1', listId, archived: true }),
        getTaskList({ orgId: 'org-1', actorId: 'usr-1', listId }),
        listTaskListEvents({ orgId: 'org-1', actorId: 'usr-1', listId, query: {} }),
      ]
      for (const call of calls) await expect(call).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(state.calls.some((call) => (call.params ?? []).includes(listId))).toBe(false)
      expect(vi.mocked(query).mock.calls.some((call) => ((call[1] ?? []) as unknown[]).includes(listId))).toBe(false)
    }
  })
})

describe('task list members (M4 PR-3a S6)', () => {
  const base = { orgId: 'org-1', actorId: 'usr-1', listId: 'tlst_1' }

  function listRow(myRole: string | null, createdBy = 'usr-0'): Record<string, unknown> {
    return {
      id: 'tlst_1', name: 'n', created_by: createdBy, archived_at: null, created_at: new Date(0), updated_at: new Date(0),
      owner_id: 'usr-1', my_role: myRole,
    }
  }

  /** Answers the list read, the member read and the org lookup; everything else stays empty. */
  function respondWith(input: { myRole: string | null; members: Array<[string, string]>; active: string[] }): void {
    state.respond = (sql) => {
      if (sql.includes('FROM task_lists')) return { rows: input.myRole === undefined ? [] : [listRow(input.myRole)] }
      if (sql.includes('FROM task_list_members')) return { rows: input.members.map(([user_id, role]) => ({ user_id, role })) }
      if (sql.includes('FROM user_orgs')) return { rows: input.active.map((user_id) => ({ user_id })) }
      return undefined
    }
  }

  function sqls(): string[] {
    return state.calls.map((call) => call.sql.replace(/\s+/g, ' ').trim())
  }

  function writes(): string[] {
    return sqls().filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql))
  }

  beforeEach(() => {
    state.calls.length = 0
    state.transactions = 0
    state.respond = undefined
    vi.mocked(query).mockClear()
  })

  it('member writes start with READ COMMITTED; a missing list is 404 before the body or the path id is looked at; nothing written, no org lookup', async () => {
    const calls = [
      () => addTaskListMember({ ...base, listId: 'tlst_missing', body: { userId: '..', role: 'admin' } }),
      () => changeTaskListMemberRole({ ...base, listId: 'tlst_missing', userId: '..', body: { role: 'owner' } }),
      () => removeTaskListMember({ ...base, listId: 'tlst_missing', userId: '..' }),
      () => transferTaskListOwner({ ...base, listId: 'tlst_missing', body: { userId: '' } }),
    ]
    for (const call of calls) {
      state.calls.length = 0
      await expect(call()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(state.calls[0]?.sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      expect(state.calls[1]?.sql).toContain('pg_advisory_xact_lock')
      expect(writes()).toEqual([])
      expect(state.calls.some((c) => c.sql.includes('user_orgs'))).toBe(false)
    }
  })

  it('a list id that cannot be stored is 404 on every member function and no statement carries it', async () => {
    for (const listId of ['tlst_\u0000', 'tlst a', '清单', '']) {
      state.calls.length = 0
      vi.mocked(query).mockClear()
      const calls = [
        listTaskListMembers({ ...base, listId, query: {} }),
        addTaskListMember({ ...base, listId, body: { userId: 'usr-2', role: 'read' } }),
        changeTaskListMemberRole({ ...base, listId, userId: 'usr-2', body: { role: 'read' } }),
        removeTaskListMember({ ...base, listId, userId: 'usr-2' }),
        transferTaskListOwner({ ...base, listId, body: { userId: 'usr-2' } }),
      ]
      for (const call of calls) await expect(call).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(state.calls.some((call) => (call.params ?? []).includes(listId))).toBe(false)
      expect(vi.mocked(query).mock.calls.some((call) => ((call[1] ?? []) as unknown[]).includes(listId))).toBe(false)
    }
  })

  it('a caller without a member row is 404 before any ability, body or path id, with nothing written', async () => {
    respondWith({ myRole: null, members: [['usr-0', 'owner']], active: ['usr-2'] })
    const calls = [
      () => addTaskListMember({ ...base, body: { userId: 'usr-2', role: 'read' } }),
      () => changeTaskListMemberRole({ ...base, userId: 'usr-0', body: { role: 'read' } }),
      () => removeTaskListMember({ ...base, userId: 'usr-1' }),
      () => removeTaskListMember({ ...base, userId: '..' }),
      () => transferTaskListOwner({ ...base, body: { userId: 'usr-0' } }),
    ]
    for (const call of calls) {
      state.calls.length = 0
      await expect(call()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(writes()).toEqual([])
      expect(state.calls.some((c) => c.sql.includes('user_orgs'))).toBe(false)
      // The roster is not assembled for a caller who is not a member.
      expect(sqls().some((sql) => sql.startsWith('SELECT user_id, role FROM task_list_members'))).toBe(false)
    }
  })

  it('addTaskListMember: the org lookup runs inside the transaction after the lock; a negative answer is 422 and writes nothing', async () => {
    respondWith({ myRole: 'edit', members: [['usr-0', 'owner'], ['usr-1', 'edit']], active: [] })
    await expect(addTaskListMember({ ...base, body: { userId: 'usr-2', role: 'read' } }))
      .rejects.toMatchObject({ status: 422, code: 'INACTIVE_ORG_MEMBER' })
    expect(state.transactions).toBe(1)
    expect(sqls()[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(sqls()[1]).toContain('pg_advisory_xact_lock')
    const lookup = state.calls.findIndex((call) => call.sql.includes('FROM user_orgs'))
    expect(lookup).toBeGreaterThan(1)
    expect(state.calls[lookup].params).toEqual(['org-1', ['usr-2']])
    expect(state.calls[lookup].sql).toContain('uo.is_active = true')
    expect(state.calls[lookup].sql).toContain('u.is_active = true')
    expect(writes()).toEqual([])
    expect(vi.mocked(query)).not.toHaveBeenCalled()
  })

  it('addTaskListMember: an existing member is a no-op whatever the lookup says; a new active member is one INSERT and one event with the target', async () => {
    respondWith({ myRole: 'owner', members: [['usr-1', 'owner'], ['usr-2', 'read']], active: [] })
    await expect(addTaskListMember({ ...base, body: { userId: 'usr-2', role: 'edit' } }))
      .resolves.toEqual({ id: 'tlst_1', members: [{ userId: 'usr-1', role: 'owner' }, { userId: 'usr-2', role: 'read' }] })
    expect(writes()).toEqual([])

    state.calls.length = 0
    respondWith({ myRole: 'owner', members: [['usr-1', 'owner']], active: ['usr-2'] })
    await expect(addTaskListMember({ ...base, body: { userId: 'usr-2', role: 'edit' } }))
      .resolves.toEqual({ id: 'tlst_1', members: [{ userId: 'usr-1', role: 'owner' }, { userId: 'usr-2', role: 'edit' }] })
    const written = state.calls.filter((call) => /^\s*(INSERT|UPDATE|DELETE)/.test(call.sql))
    expect(written).toHaveLength(2)
    expect(written[0].sql).toMatch(/^INSERT INTO task_list_members /)
    expect(written[0].params).toEqual(['tlst_1', 'usr-2', 'edit'])
    expect(written[1].sql).toMatch(/^INSERT INTO task_list_events /)
    expect(written[1].params?.slice(2)).toEqual(['usr-1', 'member_added', JSON.stringify({ targetUserId: 'usr-2' })])
  })

  it('addTaskListMember: the member id is checked before the role ([own-41]); both before the roster and the lookup', async () => {
    respondWith({ myRole: 'edit', members: [['usr-0', 'owner'], ['usr-1', 'edit']], active: ['usr-2'] })
    await expect(addTaskListMember({ ...base, body: { userId: '..', role: 'owner' } }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_MEMBER' })
    expect(sqls().some((sql) => sql.startsWith('SELECT user_id, role FROM task_list_members'))).toBe(false)
    expect(state.calls.some((c) => c.sql.includes('user_orgs'))).toBe(false)
    state.calls.length = 0
    await expect(addTaskListMember({ ...base, body: { userId: 'usr-2', role: 'owner' } }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_ROLE' })
    expect(state.calls.some((c) => c.sql.includes('user_orgs'))).toBe(false)
    expect(writes()).toEqual([])
  })

  it('removeTaskListMember: a read member may only name themselves; the path id is checked after that; the roster is read only then', async () => {
    respondWith({ myRole: 'read', members: [['usr-0', 'owner'], ['usr-1', 'read'], ['usr-2', 'read']], active: [] })
    for (const userId of ['usr-2', '..']) {
      state.calls.length = 0
      await expect(removeTaskListMember({ ...base, userId })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(sqls().some((sql) => sql.startsWith('SELECT user_id, role FROM task_list_members'))).toBe(false)
      expect(writes()).toEqual([])
    }
    state.calls.length = 0
    await expect(removeTaskListMember({ ...base, userId: 'usr-1' }))
      .resolves.toEqual({ id: 'tlst_1', members: [{ userId: 'usr-0', role: 'owner' }, { userId: 'usr-2', role: 'read' }] })
    const written = state.calls.filter((call) => /^\s*(INSERT|UPDATE|DELETE)/.test(call.sql))
    expect(written.map((call) => call.sql.split(' ').slice(0, 3).join(' '))).toEqual(['DELETE FROM task_list_members', 'INSERT INTO task_list_events'])
    // The whole statement: one row of this list (M4G4T-01).
    expect(written[0].sql.replace(/\s+/g, ' ').trim()).toBe('DELETE FROM task_list_members WHERE list_id = $1 AND user_id = $2')
    expect(written[0].params).toEqual(['tlst_1', 'usr-1'])
    expect(written[1].params?.slice(2)).toEqual(['usr-1', 'member_removed', JSON.stringify({ targetUserId: 'usr-1' })])
    // An editor naming a malformed id is 422 after the ability check, not 404.
    respondWith({ myRole: 'edit', members: [['usr-0', 'owner'], ['usr-1', 'edit']], active: [] })
    state.calls.length = 0
    await expect(removeTaskListMember({ ...base, userId: '..' })).rejects.toMatchObject({ status: 422, code: 'INVALID_MEMBER' })
    expect(writes()).toEqual([])
  })

  it('transferTaskListOwner: the lookup runs only for a transfer that changes something and before any role update; demote precedes promote', async () => {
    respondWith({ myRole: 'owner', members: [['usr-1', 'owner'], ['usr-2', 'edit']], active: ['usr-2'] })
    await expect(transferTaskListOwner({ ...base, body: { userId: 'usr-2' } }))
      .resolves.toEqual({ id: 'tlst_1', members: [{ userId: 'usr-1', role: 'edit' }, { userId: 'usr-2', role: 'owner' }] })
    const lookup = state.calls.findIndex((call) => call.sql.includes('FROM user_orgs'))
    const written = state.calls.map((call, index) => ({ call, index })).filter(({ call }) => /^\s*(INSERT|UPDATE|DELETE)/.test(call.sql))
    expect(lookup).toBeGreaterThan(1)
    expect(written.map(({ index }) => index > lookup)).toEqual([true, true, true])
    expect(written[0].call.sql).toMatch(/^UPDATE task_list_members SET role = 'edit' /)
    expect(written[0].call.params).toEqual(['tlst_1', 'usr-1'])
    expect(written[1].call.sql).toMatch(/^UPDATE task_list_members SET role = 'owner' /)
    expect(written[1].call.params).toEqual(['tlst_1', 'usr-2'])
    // The whole statements: one row of this list each (M4G4T-01).
    expect(written.slice(0, 2).map(({ call }) => call.sql.replace(/\s+/g, ' ').trim())).toEqual([
      "UPDATE task_list_members SET role = 'edit' WHERE list_id = $1 AND user_id = $2",
      "UPDATE task_list_members SET role = 'owner' WHERE list_id = $1 AND user_id = $2",
    ])
    expect(written[2].call.sql).toMatch(/^INSERT INTO task_list_events /)
    expect(written[2].call.params?.slice(2)).toEqual(['usr-1', 'owner_transferred', JSON.stringify({ targetUserId: 'usr-2' })])

    // The current owner as target: no lookup, nothing written.
    state.calls.length = 0
    await expect(transferTaskListOwner({ ...base, body: { userId: 'usr-1' } }))
      .resolves.toEqual({ id: 'tlst_1', members: [{ userId: 'usr-1', role: 'owner' }, { userId: 'usr-2', role: 'edit' }] })
    expect(state.calls.some((c) => c.sql.includes('user_orgs'))).toBe(false)
    expect(writes()).toEqual([])

    // A target that is not a member: no lookup, nothing written.
    state.calls.length = 0
    await expect(transferTaskListOwner({ ...base, body: { userId: 'usr-9' } }))
      .rejects.toMatchObject({ status: 422, code: 'TARGET_NOT_MEMBER' })
    expect(state.calls.some((c) => c.sql.includes('user_orgs'))).toBe(false)
    expect(writes()).toEqual([])

    // An inactive target: the lookup answers, nothing is written.
    respondWith({ myRole: 'owner', members: [['usr-1', 'owner'], ['usr-2', 'edit']], active: [] })
    state.calls.length = 0
    await expect(transferTaskListOwner({ ...base, body: { userId: 'usr-2' } }))
      .rejects.toMatchObject({ status: 422, code: 'INACTIVE_ORG_MEMBER' })
    expect(writes()).toEqual([])
  })

  it('changeTaskListMemberRole: a target that is not a member is 404 after the body is parsed; the owner is 422; the same role writes nothing', async () => {
    respondWith({ myRole: 'edit', members: [['usr-0', 'owner'], ['usr-1', 'edit'], ['usr-2', 'read']], active: [] })
    await expect(changeTaskListMemberRole({ ...base, userId: 'usr-9', body: { role: 'read' } })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    await expect(changeTaskListMemberRole({ ...base, userId: 'usr-9', body: { role: 'owner' } })).rejects.toMatchObject({ status: 422, code: 'INVALID_ROLE' })
    await expect(changeTaskListMemberRole({ ...base, userId: 'usr-0', body: { role: 'read' } })).rejects.toMatchObject({ status: 422, code: 'OWNER_MUST_TRANSFER' })
    await expect(changeTaskListMemberRole({ ...base, userId: 'usr-2', body: { role: 'read' } }))
      .resolves.toEqual({ id: 'tlst_1', members: [{ userId: 'usr-0', role: 'owner' }, { userId: 'usr-1', role: 'edit' }, { userId: 'usr-2', role: 'read' }] })
    expect(writes()).toEqual([])
    state.calls.length = 0
    await expect(changeTaskListMemberRole({ ...base, userId: 'usr-2', body: { role: 'edit' } }))
      .resolves.toEqual({ id: 'tlst_1', members: [{ userId: 'usr-0', role: 'owner' }, { userId: 'usr-1', role: 'edit' }, { userId: 'usr-2', role: 'edit' }] })
    const written = state.calls.filter((call) => /^\s*(INSERT|UPDATE|DELETE)/.test(call.sql))
    expect(written[0].sql).toMatch(/^UPDATE task_list_members SET role = \$3 /)
    // The whole statement: one row of this list (M4G4T-01).
    expect(written[0].sql.replace(/\s+/g, ' ').trim()).toBe('UPDATE task_list_members SET role = $3 WHERE list_id = $1 AND user_id = $2')
    expect(written[0].params).toEqual(['tlst_1', 'usr-2', 'edit'])
    expect(written[1].params?.slice(2)).toEqual(['usr-1', 'member_role_changed', JSON.stringify({ targetUserId: 'usr-2' })])
  })
})

describe('task list items (M4 PR-3a S7)', () => {
  const base = { orgId: 'org-1', actorId: 'usr-1', listId: 'tlst_1' }

  function listRow(myRole: string | null): Record<string, unknown> {
    return {
      id: 'tlst_1', name: 'n', created_by: 'usr-0', archived_at: null, created_at: new Date(0), updated_at: new Date(0),
      owner_id: 'usr-0', my_role: myRole,
    }
  }

  interface Seed {
    list?: boolean
    myRole: string | null
    task?: { createdBy: string; assignees?: string[]; followers?: string[] }
    holding?: string[]
    memberships?: Array<[string, string]>
  }

  /** Answers the list read, the task read, its role rows and the lists holding it; writes get no rows. */
  function respondWith(seed: Seed): void {
    state.respond = (sql) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) return undefined
      if (sql.includes('FROM task_lists WHERE')) return { rows: seed.list === false ? [] : [listRow(seed.myRole)] }
      if (sql.includes('FROM tasks WHERE')) {
        return { rows: seed.task ? [{ created_by: seed.task.createdBy, completion_mode: 'all', status: 'open', parent_id: null, depth: 0, version: 1 }] : [] }
      }
      if (sql.includes('FROM task_assignees')) return { rows: (seed.task?.assignees ?? []).map((user_id) => ({ user_id, completed_at: null })) }
      if (sql.includes('FROM task_followers')) return { rows: (seed.task?.followers ?? []).map((user_id) => ({ user_id })) }
      if (sql.includes('holding_list')) return { rows: (seed.holding ?? []).map((list_id) => ({ list_id })) }
      if (sql.includes('JOIN task_list_members tlm ')) {
        return { rows: (seed.memberships ?? []).map(([list_id, role]) => ({ task_id: 'tsk_1', list_id, role })) }
      }
      return undefined
    }
  }

  function sqls(): string[] {
    return state.calls.map((call) => call.sql.replace(/\s+/g, ' ').trim())
  }

  function written(): Array<{ sql: string; params?: unknown[] }> {
    return state.calls
      .map((call) => ({ sql: call.sql.replace(/\s+/g, ' ').trim(), params: call.params }))
      .filter((call) => /^(INSERT|UPDATE|DELETE)/.test(call.sql))
  }

  beforeEach(() => {
    state.calls.length = 0
    state.transactions = 0
    state.respond = undefined
    vi.mocked(query).mockReset()
    vi.mocked(query).mockImplementation(async () => ({ rows: [] }) as never)
  })

  it('item writes start with READ COMMITTED and the lock; a missing list is 404 before the body or the task is looked at; nothing written', async () => {
    respondWith({ list: false, myRole: null })
    const calls = [
      () => addTaskToList({ ...base, body: { taskId: '' } }),
      () => removeTaskFromList({ ...base, taskId: 'tsk_1' }),
    ]
    for (const call of calls) {
      state.calls.length = 0
      await expect(call()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(sqls()[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      expect(sqls()[1]).toContain('pg_advisory_xact_lock')
      expect(sqls().some((sql) => sql.includes('FROM tasks WHERE'))).toBe(false)
      expect(written()).toEqual([])
    }
  })

  it('list and task ids that cannot be stored are 404 and no statement carries them', async () => {
    respondWith({ myRole: 'edit', task: { createdBy: 'usr-1' } })
    for (const bad of ['tlst_\u0000', 'tlst a', '清单', '']) {
      state.calls.length = 0
      vi.mocked(query).mockClear()
      const calls = [
        listTaskListItems({ ...base, listId: bad, query: {} }),
        addTaskToList({ ...base, listId: bad, body: { taskId: 'tsk_1' } }),
        removeTaskFromList({ ...base, listId: bad, taskId: 'tsk_1' }),
        removeTaskFromList({ ...base, taskId: bad }),
      ]
      for (const call of calls) await expect(call).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(state.calls.some((call) => (call.params ?? []).includes(bad))).toBe(false)
      expect(vi.mocked(query).mock.calls.some((call) => ((call[1] ?? []) as unknown[]).includes(bad))).toBe(false)
      expect(written()).toEqual([])
    }
  })

  it('addTaskToList: a member without add_item is 404 before the body; an editor with a bad taskId is 422 INVALID_TASK before the task is read', async () => {
    respondWith({ myRole: 'read', task: { createdBy: 'usr-1' } })
    await expect(addTaskToList({ ...base, body: { taskId: 7 } })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(sqls().some((sql) => sql.includes('FROM tasks WHERE'))).toBe(false)
    respondWith({ myRole: 'edit', task: { createdBy: 'usr-1' } })
    for (const body of [{}, { taskId: '' }, { taskId: 7 }, { taskId: ['tsk_1'] }, { taskId: 'tsk\u0000' }, { taskId: 'tsk 1' }, { taskId: '任务' }, [{ taskId: 'tsk_1' }]]) {
      state.calls.length = 0
      await expect(addTaskToList({ ...base, body })).rejects.toMatchObject({ status: 422, code: 'INVALID_TASK' })
      expect(sqls().some((sql) => sql.includes('FROM tasks WHERE'))).toBe(false)
      expect(written()).toEqual([])
    }
  })

  it('addTaskToList: direct roles only, list identity is never read; the no-op and the quota come after the task side; a new item is one INSERT and two events', async () => {
    // An edit member who holds the task only through a list: refused before the holding lists are read.
    respondWith({ myRole: 'edit', task: { createdBy: 'usr-0', followers: ['usr-1'] }, holding: ['tlst_1'], memberships: [['tlst_1', 'edit']] })
    await expect(addTaskToList({ ...base, body: { taskId: 'tsk_1' } })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(sqls().some((sql) => sql.includes('JOIN task_list_members tlm '))).toBe(false)
    expect(sqls().some((sql) => sql.includes('holding_list'))).toBe(false)
    expect(written()).toEqual([])

    // The creator: already in the list is the no-op; at the quota it is 422 LIMIT.
    respondWith({ myRole: 'edit', task: { createdBy: 'usr-1' }, holding: ['tlst_1'] })
    state.calls.length = 0
    await expect(addTaskToList({ ...base, body: { taskId: 'tsk_1' } })).resolves.toEqual({ listId: 'tlst_1', taskId: 'tsk_1' })
    expect(written()).toEqual([])
    respondWith({ myRole: 'edit', task: { createdBy: 'usr-1' }, holding: Array.from({ length: 10 }, (_, i) => `tlst_q${i}`) })
    state.calls.length = 0
    await expect(addTaskToList({ ...base, body: { taskId: 'tsk_1' } })).rejects.toMatchObject({ status: 422, code: 'LIMIT' })
    expect(written()).toEqual([])

    // An assignee adds it: the item row, then item_added, then list_added, both copying the item's instant.
    respondWith({ myRole: 'edit', task: { createdBy: 'usr-0', assignees: ['usr-1'] }, holding: [] })
    state.calls.length = 0
    await expect(addTaskToList({ ...base, body: { taskId: 'tsk_1' } })).resolves.toEqual({ listId: 'tlst_1', taskId: 'tsk_1' })
    const writes = written()
    expect(writes.map((call) => call.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'INSERT INTO task_list_items', 'INSERT INTO task_list_events', 'INSERT INTO task_events',
    ])
    expect(writes[0].params).toEqual(['tlst_1', 'tsk_1', 'org-1'])
    expect(writes[0].sql).toContain('clock_timestamp()')
    expect(writes[1].params?.slice(1)).toEqual(['tlst_1', 'usr-1', 'item_added', JSON.stringify({ taskId: 'tsk_1' }), 'tsk_1'])
    expect(writes[1].sql).toContain('created_at FROM task_list_items')
    expect(writes[2].params?.slice(1)).toEqual(['tsk_1', 'usr-1', 'list_added', JSON.stringify({ listId: 'tlst_1' }), 'tlst_1'])
    expect(writes[2].sql).toContain('created_at FROM task_list_items')
  })

  it('removeTaskFromList: neither way in is the 404 after the reads; the creator way needs the item; a member who edits the task gets the no-op; a removal is two deletes and two events sharing one instant', async () => {
    for (const seed of [
      { myRole: null, task: { createdBy: 'usr-0' }, holding: ['tlst_1'] },
      { myRole: null, task: { createdBy: 'usr-1' }, holding: [] },
      { myRole: 'read', task: { createdBy: 'usr-0' }, holding: ['tlst_1'], memberships: [['tlst_1', 'read']] as Array<[string, string]> },
      { myRole: 'edit', task: { createdBy: 'usr-0' }, holding: [] },
    ]) {
      respondWith(seed)
      state.calls.length = 0
      await expect(removeTaskFromList({ ...base, taskId: 'tsk_1' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(written()).toEqual([])
    }

    respondWith({ myRole: 'edit', task: { createdBy: 'usr-0', assignees: ['usr-1'] }, holding: [] })
    state.calls.length = 0
    await expect(removeTaskFromList({ ...base, taskId: 'tsk_1' })).resolves.toEqual({ listId: 'tlst_1', taskId: 'tsk_1' })
    expect(written()).toEqual([])

    // The creator, not a member, removes it.
    respondWith({ myRole: null, task: { createdBy: 'usr-1' }, holding: ['tlst_1', 'tlst_2'] })
    state.calls.length = 0
    await expect(removeTaskFromList({ ...base, taskId: 'tsk_1' })).resolves.toEqual({ listId: 'tlst_1', taskId: 'tsk_1' })
    const writes = written()
    expect(writes.map((call) => call.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'DELETE FROM task_list_items', 'DELETE FROM task_group_items', 'INSERT INTO task_list_events', 'INSERT INTO task_events',
    ])
    expect(writes[0].params).toEqual(['tlst_1', 'tsk_1'])
    expect(writes[1].sql).toContain('g.list_id = $1')
    expect(writes[1].params).toEqual(['tlst_1', 'tsk_1'])
    // The whole statements: this task's item of this list, and its placements in this list's groups (M4G4T-02).
    expect(writes.slice(0, 2).map((call) => call.sql)).toEqual([
      'DELETE FROM task_list_items WHERE list_id = $1 AND task_id = $2',
      'DELETE FROM task_group_items gi USING task_groups g WHERE gi.group_id = g.id AND g.list_id = $1 AND gi.task_id = $2',
    ])
    expect(writes[2].sql).toContain('clock_timestamp()')
    expect(writes[2].params?.slice(1)).toEqual(['tlst_1', 'usr-1', 'item_removed', JSON.stringify({ taskId: 'tsk_1' })])
    expect(writes[3].sql).toContain('occurred_at FROM task_list_events WHERE id = $6')
    expect(writes[3].params?.slice(1)).toEqual(['tsk_1', 'usr-1', 'list_removed', JSON.stringify({ listId: 'tlst_1' }), writes[2].params?.[0]])
  })

  it('listTaskListItems: a non-member is 404 before the page; a member with a bad page is 422; the read is the in-list condition in the task page order', async () => {
    const answer = (myRole: string | null) => vi.mocked(query).mockImplementation(
      (async (sql: string) => ({ rows: sql.includes('FROM task_lists WHERE') ? [listRow(myRole)] : [] })) as never,
    )
    answer(null)
    await expect(listTaskListItems({ ...base, query: { limit: '0' } })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    answer('read')
    await expect(listTaskListItems({ ...base, query: { limit: '0' } })).rejects.toMatchObject({ status: 422, code: 'INVALID_LIMIT' })
    vi.mocked(query).mockClear()
    await expect(listTaskListItems({ ...base, query: { limit: '2', offset: '1' } })).resolves.toEqual({ items: [], total: 0 })
    const statements = vi.mocked(query).mock.calls.map((call) => ({ sql: String(call[0]).replace(/\s+/g, ' ').trim(), params: call[1] }))
    const read = statements.find((call) => call.sql.startsWith('SELECT id, title, status, completion_mode, created_by, due_at FROM tasks'))
    expect(read?.sql).toContain('EXISTS (SELECT 1 FROM task_list_items tli WHERE tli.task_id = tasks.id AND tli.list_id = $1)')
    expect(read?.sql).toContain('ORDER BY tasks.updated_at DESC, tasks.id DESC LIMIT $3 OFFSET $4')
    expect(read?.params).toEqual(['tlst_1', 'org-1', 2, 1])
  })
})

describe('task groups (M4 PR-3a S8)', () => {
  const base = { orgId: 'org-1', actorId: 'usr-1', listId: 'tlst_1' }

  function listRow(myRole: string | null): Record<string, unknown> {
    return {
      id: 'tlst_1', name: 'n', created_by: 'usr-0', archived_at: null, created_at: new Date(0), updated_at: new Date(0),
      owner_id: 'usr-0', my_role: myRole,
    }
  }

  interface Seed {
    list?: boolean
    myRole?: string | null
    groups?: Array<{ id: string; name?: string; position: number; is_default: boolean }>
    visibleTask?: boolean
    taskGroups?: string[]
    groupRows?: Array<{ task_id: string; visible: boolean }>
  }

  /** Answers the list, the container's groups, the task's visibility, the groups holding it and the
   * target group's rows; writes get no rows. */
  function respondWith(seed: Seed): void {
    state.respond = (sql) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) return undefined
      if (sql.includes('FROM task_lists WHERE')) return { rows: seed.list === false ? [] : [listRow(seed.myRole ?? null)] }
      if (sql.includes('SELECT tasks.id FROM tasks WHERE')) return { rows: seed.visibleTask ? [{ id: 'tsk_1' }] : [] }
      if (sql.includes('SELECT task_group_items.group_id FROM task_group_items')) return { rows: (seed.taskGroups ?? []).map((group_id) => ({ group_id })) }
      if (sql.includes(') AS visible')) return { rows: seed.groupRows ?? [] }
      if (sql.includes('FROM task_groups WHERE')) return { rows: (seed.groups ?? []).map((group) => ({ name: 'g', ...group })) }
      return undefined
    }
  }

  function sqls(): string[] {
    return state.calls.map((call) => call.sql.replace(/\s+/g, ' ').trim())
  }

  function written(): Array<{ sql: string; params?: unknown[] }> {
    return state.calls
      .map((call) => ({ sql: call.sql.replace(/\s+/g, ' ').trim(), params: call.params }))
      .filter((call) => /^(INSERT|UPDATE|DELETE)/.test(call.sql))
  }

  const DEFAULT = { id: 'tgrp_d', position: 0, is_default: true }
  const A = { id: 'tgrp_a', position: 1, is_default: false }
  const B = { id: 'tgrp_b', position: 2, is_default: false }

  beforeEach(() => {
    state.calls.length = 0
    state.transactions = 0
    state.respond = undefined
    vi.mocked(query).mockReset()
    vi.mocked(query).mockImplementation(async () => ({ rows: [] }) as never)
  })

  it('every group write starts with READ COMMITTED and the org\'s structure lock; a missing list is 404 before the body, the group or the task is looked at; nothing written', async () => {
    respondWith({ list: false, groups: [DEFAULT, A], visibleTask: true })
    const calls = [
      () => createTaskListGroup({ ...base, body: { name: '' } }),
      () => renameTaskListGroup({ ...base, groupId: 'tgrp_a', body: {} }),
      () => deleteTaskListGroup({ ...base, groupId: 'tgrp_a' }),
      () => placeTaskInListGroup({ ...base, taskId: 'tsk_1', body: {} }),
    ]
    for (const call of calls) {
      state.calls.length = 0
      await expect(call()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(sqls()[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      expect(sqls()[1]).toContain('pg_advisory_xact_lock')
      expect(state.calls[1].params).toEqual(['task-structure:org-1'])
      expect(sqls().slice(2).every((sql) => sql.includes('FROM task_lists WHERE'))).toBe(true)
      expect(written()).toEqual([])
    }
    // The personal writes take the same org lock: the key is the org's, never the caller's.
    const personal = { orgId: 'org-1', actorId: 'usr-1' }
    for (const call of [
      () => createUserTaskGroup({ ...personal, body: { name: '我的' } }),
      () => renameUserTaskGroup({ ...personal, groupId: 'tgrp_a', body: { name: '改名' } }),
      () => deleteUserTaskGroup({ ...personal, groupId: 'tgrp_a' }),
      () => placeTaskInUserGroup({ ...personal, taskId: 'tsk_1', body: { groupId: null, position: 0 } }),
    ]) {
      state.calls.length = 0
      await call()
      expect(sqls()[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      expect(sqls()[1]).toContain('pg_advisory_xact_lock')
      expect(state.calls[1].params).toEqual(['task-structure:org-1'])
    }
  })

  it('a read member is 404 on every list-scope group write before the body; an edit member\'s bad name is 422 only after the group is found', async () => {
    respondWith({ myRole: 'read', groups: [DEFAULT, A], visibleTask: true })
    for (const call of [
      () => createTaskListGroup({ ...base, body: { name: 'ok' } }),
      () => renameTaskListGroup({ ...base, groupId: 'tgrp_a', body: { name: 'ok' } }),
      () => deleteTaskListGroup({ ...base, groupId: 'tgrp_a' }),
      () => placeTaskInListGroup({ ...base, taskId: 'tsk_1', body: { groupId: null, position: 0 } }),
    ]) {
      state.calls.length = 0
      await expect(call()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(sqls().some((sql) => sql.includes('FROM task_groups WHERE') || sql.includes('FROM tasks WHERE'))).toBe(false)
      expect(written()).toEqual([])
    }
    respondWith({ myRole: 'edit', groups: [DEFAULT, A] })
    await expect(renameTaskListGroup({ ...base, groupId: 'tgrp_missing', body: { name: '' } })).rejects.toMatchObject({ status: 404 })
    await expect(renameTaskListGroup({ ...base, groupId: 'tgrp_a', body: { name: '' } })).rejects.toMatchObject({ status: 422, code: 'INVALID_NAME' })
    await expect(createTaskListGroup({ ...base, body: { name: 'a'.repeat(101) } })).rejects.toMatchObject({ status: 422, code: 'NAME_TOO_LONG' })
    expect(written()).toEqual([])
  })

  it('createUserTaskGroup checks the name before a transaction opens', async () => {
    for (const body of [{}, { name: ' ' }, { name: 'x\u0000' }, { name: 7 }, null]) {
      await expect(createUserTaskGroup({ orgId: 'org-1', actorId: 'usr-1', body })).rejects.toMatchObject({ status: 422, code: 'INVALID_NAME' })
    }
    expect(state.transactions).toBe(0)
  })

  it('ids that cannot be stored are 404 and no statement carries them', async () => {
    respondWith({ myRole: 'owner', groups: [DEFAULT, A], visibleTask: true })
    for (const bad of ['tgrp_\u0000', 'tgrp a', '分组', '']) {
      state.calls.length = 0
      vi.mocked(query).mockClear()
      const calls = [
        listTaskListGroups({ ...base, listId: bad, query: {} }),
        listTaskListGroupItems({ ...base, listId: bad, query: {} }),
        createTaskListGroup({ ...base, listId: bad, body: { name: 'n' } }),
        renameTaskListGroup({ ...base, groupId: bad, body: { name: 'n' } }),
        deleteTaskListGroup({ ...base, groupId: bad }),
        placeTaskInListGroup({ ...base, taskId: bad, body: { groupId: null, position: 0 } }),
        renameUserTaskGroup({ orgId: 'org-1', actorId: 'usr-1', groupId: bad, body: { name: 'n' } }),
        deleteUserTaskGroup({ orgId: 'org-1', actorId: 'usr-1', groupId: bad }),
        placeTaskInUserGroup({ orgId: 'org-1', actorId: 'usr-1', taskId: bad, body: { groupId: null, position: 0 } }),
      ]
      for (const call of calls) await expect(call).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(state.calls.some((call) => (call.params ?? []).includes(bad))).toBe(false)
      expect(vi.mocked(query).mock.calls.some((call) => ((call[1] ?? []) as unknown[]).includes(bad))).toBe(false)
      expect(written()).toEqual([])
    }
  })

  it('placeTask: the task comes before the body; groupId before position; a group outside the container is INVALID_GROUP before any row of it is read', async () => {
    respondWith({ myRole: 'edit', groups: [DEFAULT, A], visibleTask: false })
    await expect(placeTaskInListGroup({ ...base, taskId: 'tsk_1', body: { groupId: 7, position: 'x' } })).rejects.toMatchObject({ status: 404 })
    respondWith({ myRole: 'edit', groups: [DEFAULT, A], visibleTask: true })
    state.calls.length = 0
    await expect(placeTaskInListGroup({ ...base, taskId: 'tsk_1', body: { groupId: 7, position: 'x' } })).rejects.toMatchObject({ status: 422, code: 'INVALID_GROUP' })
    expect(sqls().some((sql) => sql.includes('FROM task_group_items'))).toBe(false)
    state.calls.length = 0
    await expect(placeTaskInListGroup({ ...base, taskId: 'tsk_1', body: { groupId: 'tgrp_other', position: 0 } })).rejects.toMatchObject({ status: 422, code: 'INVALID_GROUP' })
    expect(sqls().some((sql) => sql.includes('FROM task_group_items'))).toBe(false)
    state.calls.length = 0
    await expect(placeTaskInListGroup({ ...base, taskId: 'tsk_1', body: { groupId: 'tgrp_a', position: 1 } })).rejects.toMatchObject({ status: 422, code: 'INVALID_POSITION' })
    expect(written()).toEqual([])
    // The task check binds the container's visible set: the list's items in the org.
    const check = sqls().find((sql) => sql.startsWith('SELECT tasks.id FROM tasks WHERE'))
    expect(check).toContain('EXISTS (SELECT 1 FROM task_list_items tli WHERE tli.task_id = tasks.id AND tli.list_id = $1)')
    expect(check).toContain('AND tasks.id = $3')
  })

  it('placeTask (list): a move writes the container-scoped delete, the new row at one clock reading, the target positions and group_changed copying the new row; the same visible order writes nothing', async () => {
    respondWith({
      myRole: 'edit', groups: [DEFAULT, A, B], visibleTask: true, taskGroups: ['tgrp_a'],
      groupRows: [{ task_id: 'tsk_x', visible: true }, { task_id: 'tsk_h', visible: false }, { task_id: 'tsk_y', visible: true }],
    })
    await expect(placeTaskInListGroup({ ...base, taskId: 'tsk_1', body: { groupId: 'tgrp_b', position: 1 } }))
      .resolves.toEqual({ taskId: 'tsk_1', groupId: 'tgrp_b', position: 1 })
    const writes = written()
    expect(writes.map((call) => call.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'DELETE FROM task_group_items', 'INSERT INTO task_group_items', 'UPDATE task_group_items SET', 'INSERT INTO task_events',
    ])
    expect(writes[0].sql).toContain("(task_groups.org_id = $2) AND task_groups.scope = 'list' AND task_groups.list_id = $1")
    expect(writes[0].sql).toContain('task_group_items.task_id = $3 AND task_group_items.group_id <> $4')
    expect(writes[0].params).toEqual(['tlst_1', 'org-1', 'tsk_1', 'tgrp_b'])
    expect(writes[1].sql).toContain('clock_timestamp()')
    expect(writes[1].params).toEqual(['tgrp_b', 'tsk_1', 'org-1', 1])
    expect(writes[2].params).toEqual(['tgrp_b', ['tsk_x', 'tsk_1', 'tsk_y', 'tsk_h'], [0, 1, 2, 3]])
    expect(writes[3].sql).toContain('created_at FROM task_group_items WHERE group_id = $6 AND task_id = $2')
    expect(writes[3].params?.slice(1)).toEqual([
      'tsk_1', 'usr-1', 'group_changed', JSON.stringify({ listId: 'tlst_1', fromGroupId: 'tgrp_a', toGroupId: 'tgrp_b' }), 'tgrp_b',
    ])

    respondWith({
      myRole: 'edit', groups: [DEFAULT, A], visibleTask: true, taskGroups: ['tgrp_a'],
      groupRows: [{ task_id: 'tsk_1', visible: true }, { task_id: 'tsk_h', visible: false }, { task_id: 'tsk_y', visible: true }],
    })
    state.calls.length = 0
    await expect(placeTaskInListGroup({ ...base, taskId: 'tsk_1', body: { groupId: 'tgrp_a', position: 0 } }))
      .resolves.toEqual({ taskId: 'tsk_1', groupId: 'tgrp_a', position: 0 })
    expect(written()).toEqual([])
  })

  it('placeTask (user): the first write lands the default group, the placement copies its instant, and nothing is an event', async () => {
    respondWith({ groups: [], visibleTask: true })
    const placed = await placeTaskInUserGroup({ orgId: 'org-1', actorId: 'usr-1', taskId: 'tsk_1', body: { groupId: null, position: 0 } })
    expect(placed).toEqual({ taskId: 'tsk_1', groupId: expect.stringMatching(/^tgrp_/), position: 0 })
    const writes = written()
    expect(writes.map((call) => call.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'INSERT INTO task_groups', 'DELETE FROM task_group_items', 'INSERT INTO task_group_items', 'UPDATE task_group_items SET',
    ])
    expect(writes[0].params).toEqual([placed.groupId, 'org-1', 'user', null, 'usr-1', '默认分组', 0, true])
    expect(writes[0].sql).toContain('clock_timestamp()')
    expect(writes[1].sql).toContain("(task_groups.org_id = $2) AND task_groups.scope = 'user' AND task_groups.user_id = $1")
    expect(writes[2].sql).toContain('src.created_at FROM task_groups AS src WHERE src.id = $5')
    expect(writes[2].params).toEqual([placed.groupId, 'tsk_1', 'org-1', 0, placed.groupId])
    // The task check binds the user's assigned arm in the org.
    const check = sqls().find((sql) => sql.startsWith('SELECT tasks.id FROM tasks WHERE'))
    expect(check).toContain('EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $1)')
  })

  it('createGroup: the next position is the count, the default counts before its row exists; group_created copies the group row; a list-scope row binds the list', async () => {
    respondWith({ myRole: 'edit', groups: [DEFAULT, A] })
    const created = await createTaskListGroup({ ...base, body: { name: ' 新 ' } })
    expect(created).toEqual({ id: expect.stringMatching(/^tgrp_/), scope: 'list', name: '新', position: 2, isDefault: false })
    const writes = written()
    expect(writes.map((call) => call.sql.split(' ').slice(0, 3).join(' '))).toEqual(['INSERT INTO task_groups', 'INSERT INTO task_list_events'])
    expect(writes[0].params).toEqual([created.id, 'org-1', 'list', 'tlst_1', null, '新', 2, false])
    expect(writes[1].sql).toContain('updated_at FROM task_groups WHERE id = $6 AND list_id = $2')
    expect(writes[1].params?.slice(1)).toEqual(['tlst_1', 'usr-1', 'group_created', JSON.stringify({ groupId: created.id }), created.id])

    respondWith({ groups: [] })
    state.calls.length = 0
    const mine = await createUserTaskGroup({ orgId: 'org-1', actorId: 'usr-1', body: { name: '我的' } })
    expect(mine.position).toBe(1)
    const userWrites = written()
    expect(userWrites.map((call) => call.sql.split(' ').slice(0, 3).join(' '))).toEqual(['INSERT INTO task_groups', 'INSERT INTO task_groups'])
    expect(userWrites[0].params?.slice(1)).toEqual(['org-1', 'user', null, 'usr-1', '默认分组', 0, true])
    expect(userWrites[1].sql).toContain('FROM task_groups AS src WHERE src.id = $9')
    expect(userWrites[1].params?.[8]).toBe(userWrites[0].params?.[0])

    respondWith({ groups: Array.from({ length: 49 }, (_, i) => ({ id: `tgrp_${i}`, position: i, is_default: false })) })
    state.calls.length = 0
    await expect(createUserTaskGroup({ orgId: 'org-1', actorId: 'usr-1', body: { name: '满' } })).rejects.toMatchObject({ status: 422, code: 'LIMIT' })
    expect(written()).toEqual([])
  })

  it('deleteGroup: the default is 422 before anything is written; a delete renumbers only the groups after it and writes group_deleted at a clock reading', async () => {
    respondWith({ myRole: 'edit', groups: [DEFAULT, A, B] })
    await expect(deleteTaskListGroup({ ...base, groupId: 'tgrp_d' })).rejects.toMatchObject({ status: 422, code: 'IS_DEFAULT' })
    expect(written()).toEqual([])
    state.calls.length = 0
    await expect(deleteTaskListGroup({ ...base, groupId: 'tgrp_a' })).resolves.toEqual({ id: 'tgrp_a', deleted: true, reassignedTo: 'tgrp_d' })
    const writes = written()
    expect(writes.map((call) => call.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'DELETE FROM task_groups', 'UPDATE task_groups SET', 'INSERT INTO task_list_events',
    ])
    expect(writes[0].params).toEqual(['tgrp_a'])
    expect(writes[1].params).toEqual([['tgrp_b'], [1]])
    expect(writes[2].sql).toContain('clock_timestamp()')
    expect(writes[2].params?.slice(1)).toEqual(['tlst_1', 'usr-1', 'group_deleted', JSON.stringify({ groupId: 'tgrp_a' })])
    // A container with groups but no default row is a broken invariant, not a 4xx.
    respondWith({ groups: [A] })
    await expect(deleteUserTaskGroup({ orgId: 'org-1', actorId: 'usr-1', groupId: 'tgrp_a' })).rejects.toThrow('without a default group')
  })

  it('reads: the list-scope groups and placements resolve the member before the page; the placement read numbers each group before LIMIT; the personal read pages the synthetic list', async () => {
    const answer = (myRole: string | null, groups: Array<Record<string, unknown>> = []) => vi.mocked(query).mockImplementation(
      (async (sql: string) => ({
        rows: sql.includes('FROM task_lists WHERE') ? [listRow(myRole)] : sql.includes('FROM task_groups WHERE') ? groups : [],
      })) as never,
    )
    answer(null)
    await expect(listTaskListGroups({ ...base, query: { limit: '0' } })).rejects.toMatchObject({ status: 404 })
    await expect(listTaskListGroupItems({ ...base, query: { limit: '0' } })).rejects.toMatchObject({ status: 404 })
    answer('read')
    await expect(listTaskListGroups({ ...base, query: { limit: '0' } })).rejects.toMatchObject({ status: 422, code: 'INVALID_LIMIT' })
    vi.mocked(query).mockClear()
    await expect(listTaskListGroupItems({ ...base, query: { limit: '2', offset: '1' } })).resolves.toEqual({ items: [], total: 0 })
    const statements = vi.mocked(query).mock.calls.map((call) => ({ sql: String(call[0]).replace(/\s+/g, ' ').trim(), params: call[1] }))
    const read = statements.find((call) => call.sql.startsWith('SELECT placement.group_id'))
    expect(read?.sql).toContain('row_number() OVER (PARTITION BY task_group_items.group_id ORDER BY task_group_items.position, task_group_items.task_id COLLATE "C")')
    expect(read?.sql).toContain(') AS placement ORDER BY placement.group_id COLLATE "C", placement.position LIMIT $3 OFFSET $4')
    expect(read?.params).toEqual(['tlst_1', 'org-1', 2, 1])

    answer(null, [])
    await expect(listUserTaskGroups({ orgId: 'org-1', actorId: 'usr-1', query: { offset: '1' } })).resolves.toEqual({ items: [], total: 1 })
    await expect(listUserTaskGroups({ orgId: 'org-1', actorId: 'usr-1', query: {} })).resolves.toEqual({
      items: [{ id: null, scope: 'user', name: '默认分组', position: 0, isDefault: true }], total: 1,
    })
    vi.mocked(query).mockClear()
    await expect(listUserTaskGroupItems({ orgId: 'org-1', actorId: 'usr-1', query: { limit: '1' } })).resolves.toEqual({ items: [], total: 0 })
    const mine = vi.mocked(query).mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' '))
    expect(mine.some((sql) => sql.includes("task_groups.scope = 'user' AND task_groups.user_id = $1") && sql.includes('ta.user_id = $1'))).toBe(true)
    expect(state.transactions).toBe(0)
  })

  it('reads: the personal read honours limit and offset over more groups than the limit (RULED(2026-10-07): [R15])', async () => {
    const rows = [
      { id: 'tgrp_d', name: '默认分组', position: 0, is_default: true },
      { id: 'tgrp_a', name: '本周', position: 1, is_default: false },
      { id: 'tgrp_b', name: '下周', position: 2, is_default: false },
    ]
    vi.mocked(query).mockImplementation(
      (async (sql: string) => ({ rows: sql.includes('FROM task_groups WHERE') ? rows : [] })) as never,
    )
    const view = (row: (typeof rows)[number]) => ({ id: row.id, scope: 'user', name: row.name, position: row.position, isDefault: row.is_default })
    const read = (query: Record<string, string>) => listUserTaskGroups({ orgId: 'org-1', actorId: 'usr-1', query })
    await expect(read({ limit: '2' })).resolves.toEqual({ items: rows.slice(0, 2).map(view), total: 3 })
    await expect(read({ limit: '2', offset: '2' })).resolves.toEqual({ items: rows.slice(2).map(view), total: 3 })
    await expect(read({ limit: '1', offset: '1' })).resolves.toEqual({ items: [view(rows[1])], total: 3 })
  })
})

// RULED(2026-10-07): [own-53]: adding or removing an assignee or a follower takes a
// direct role on the task (creator or assignee); the check runs under the lock, before the request
// body or the path user id, and reads no list identity.
describe('task member writes (M4 PR-3a, [own-53])', () => {
  const base = { orgId: 'org-1', actorId: 'usr-1', taskId: 'tsk_1' }

  interface MemberSeed {
    createdBy: string
    assignees?: string[]
    followers?: string[]
    memberships?: Array<[string, string]>
    /** Users the org lookup ([R17] [N2], S9) answers as active members. */
    active?: string[]
  }

  /** Answers the task read, its assignee and follower rows, the caller's list identity and the org
   * lookup; writes get no rows. */
  function respondWith(seed: MemberSeed): void {
    state.respond = (sql, params) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) return undefined
      if (sql.includes('FROM tasks WHERE')) {
        return { rows: [{ created_by: seed.createdBy, completion_mode: 'all', status: 'open', parent_id: null, depth: 0, version: 1 }] }
      }
      if (sql.includes('FROM task_assignees')) return { rows: (seed.assignees ?? []).map((user_id) => ({ user_id, completed_at: null })) }
      if (sql.includes('FROM task_followers')) return { rows: (seed.followers ?? []).map((user_id) => ({ user_id })) }
      if (sql.includes('JOIN task_list_members tlm ')) {
        return { rows: (seed.memberships ?? []).map(([list_id, role]) => ({ task_id: 'tsk_1', list_id, role })) }
      }
      if (sql.includes('FROM user_orgs')) {
        const asked = (params?.[1] ?? []) as string[]
        return { rows: (seed.active ?? []).filter((user_id) => asked.includes(user_id)).map((user_id) => ({ user_id })) }
      }
      return undefined
    }
  }

  function sqls(): string[] {
    return state.calls.map((call) => call.sql.replace(/\s+/g, ' ').trim())
  }

  function written(): string[] {
    return sqls().filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql))
  }

  beforeEach(() => {
    state.calls.length = 0
    state.transactions = 0
    state.respond = undefined
  })

  it('a caller whose `edit` comes only from a list is the 404 on all four writes, whatever the body or the path user id; the decision reads no list identity and nothing is written', async () => {
    respondWith({ createdBy: 'usr-0', assignees: ['usr-2'], followers: ['usr-3'], memberships: [['tlst_1', 'edit']] })
    const calls = [
      () => addAssignee({ ...base, body: { userId: 'usr-1' } }),
      () => addAssignee({ ...base, body: { userId: '..' } }),
      () => removeAssignee({ ...base, userId: 'usr-2' }),
      () => removeAssignee({ ...base, userId: '..' }),
      () => addFollower({ ...base, body: { userId: 'usr-1' } }),
      () => addFollower({ ...base, body: { userId: 7 } }),
      () => removeFollower({ ...base, userId: 'usr-3' }),
      () => removeFollower({ ...base, userId: '..' }),
    ]
    for (const call of calls) {
      state.calls.length = 0
      await expect(call()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(sqls()[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      expect(sqls()[1]).toContain('pg_advisory_xact_lock')
      expect(sqls().some((sql) => sql.includes('task_list_members'))).toBe(false)
      expect(written()).toEqual([])
    }
  })

  it('a follower is the 404 on the four writes too (it leaves through leave); the creator and an assignee pass, with the body checked only after the role', async () => {
    respondWith({ createdBy: 'usr-0', followers: ['usr-1'] })
    for (const call of [
      () => addAssignee({ ...base, body: { userId: 'usr-2' } }),
      () => removeFollower({ ...base, userId: 'usr-1' }),
    ]) {
      state.calls.length = 0
      await expect(call()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(written()).toEqual([])
    }
    state.calls.length = 0
    await expect(leaveTask(base)).resolves.toEqual({ id: 'tsk_1', followers: [] })
    expect(written().map((sql) => sql.split(' ').slice(0, 3).join(' '))).toEqual(['DELETE FROM task_followers', 'INSERT INTO task_events'])

    // The creator: a malformed id is 422 once the role allows the write; a new assignee is one row and one event.
    respondWith({ createdBy: 'usr-1', active: ['usr-2'] })
    state.calls.length = 0
    await expect(addAssignee({ ...base, body: { userId: '..' } })).rejects.toMatchObject({ status: 422, code: 'INVALID_ASSIGNEES' })
    expect(written()).toEqual([])
    state.calls.length = 0
    await expect(addAssignee({ ...base, body: { userId: 'usr-2' } }))
      .resolves.toEqual({ id: 'tsk_1', status: 'open', completionMode: 'all', assignees: [{ userId: 'usr-2', completedAt: null }] })
    expect(written().map((sql) => sql.split(' ').slice(0, 3).join(' '))).toEqual(['INSERT INTO task_assignees', 'INSERT INTO task_events'])

    // An assignee: a new follower is one row and one event; removing an assignee is one delete and one event.
    respondWith({ createdBy: 'usr-0', assignees: ['usr-1', 'usr-2'], active: ['usr-3'] })
    state.calls.length = 0
    await expect(addFollower({ ...base, body: { userId: 'usr-3' } })).resolves.toEqual({ id: 'tsk_1', followers: ['usr-3'] })
    expect(written().map((sql) => sql.split(' ').slice(0, 3).join(' '))).toEqual(['INSERT INTO task_followers', 'INSERT INTO task_events'])
    state.calls.length = 0
    await expect(removeAssignee({ ...base, userId: 'usr-2' }))
      .resolves.toEqual({ id: 'tsk_1', status: 'open', completionMode: 'all', assignees: [{ userId: 'usr-1', completedAt: null }] })
    expect(written().map((sql) => sql.split(' ').slice(0, 3).join(' '))).toEqual(['DELETE FROM task_assignees', 'INSERT INTO task_events'])
    expect(sqls().some((sql) => sql.includes('task_list_members'))).toBe(false)
  })
})

// M4 PR-3a S9 (design §4.6, §13 S9). RULED(2026-10-07): [R17] [N2] the org lookup at
// the three task writes: inside the transaction, after the lock, the direct role, the member id and
// LIMIT; only for a real addition. ASSUMPTION(task-m4): [own-16] never for the operator.
describe('task org membership (M4 PR-3a S9)', () => {
  const createBase = { orgId: 'org-1', creatorId: 'usr-1', title: '备料复核' }
  const memberBase = { orgId: 'org-1', actorId: 'usr-1', taskId: 'tsk_1' }

  interface Seed { createdBy?: string; assignees?: string[]; followers?: string[]; active?: string[] }

  /** Answers the task read, its assignee and follower rows and the org lookup (only the ids asked
   * for that are in `active`); writes get no rows. */
  function respondWith(seed: Seed): void {
    state.respond = (sql, params) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) return undefined
      if (sql.includes('FROM tasks WHERE')) {
        return { rows: [{ created_by: seed.createdBy ?? 'usr-1', completion_mode: 'all', status: 'open', parent_id: null, depth: 0, version: 1 }] }
      }
      if (sql.includes('FROM task_assignees')) return { rows: (seed.assignees ?? []).map((user_id) => ({ user_id, completed_at: null })) }
      if (sql.includes('FROM task_followers')) return { rows: (seed.followers ?? []).map((user_id) => ({ user_id })) }
      if (sql.includes('FROM user_orgs')) {
        const asked = (params?.[1] ?? []) as string[]
        return { rows: (seed.active ?? []).filter((user_id) => asked.includes(user_id)).map((user_id) => ({ user_id })) }
      }
      return undefined
    }
  }

  function sqls(): string[] {
    return state.calls.map((call) => call.sql.replace(/\s+/g, ' ').trim())
  }

  function lookups(): Array<{ sql: string; params?: unknown[] }> {
    return state.calls.filter((call) => call.sql.includes('FROM user_orgs'))
  }

  function indexOf(fragment: string): number {
    return state.calls.findIndex((call) => call.sql.includes(fragment))
  }

  function written(): string[] {
    return sqls().filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql)).map((sql) => sql.split(' ').slice(0, 3).join(' '))
  }

  beforeEach(() => {
    state.calls.length = 0
    state.transactions = 0
    state.respond = undefined
  })

  afterEach(() => {
    state.respond = undefined
  })

  it('createTask: one lookup of the ids other than the creator, after the lock and before the first INSERT; a negative answer is 422 with nothing written', async () => {
    respondWith({ active: ['usr-2'] })
    await expect(createTask({ ...createBase, assignees: ['usr-1', 'usr-2', 'usr-3'] }))
      .rejects.toMatchObject({ status: 422, code: 'INACTIVE_ORG_MEMBER' })
    expect(state.transactions).toBe(1)
    expect(lookups()).toHaveLength(1)
    expect(lookups()[0]?.params).toEqual(['org-1', ['usr-2', 'usr-3']])
    expect(indexOf('FROM user_orgs')).toBeGreaterThan(indexOf('pg_advisory_xact_lock'))
    expect(written()).toEqual([])

    state.calls.length = 0
    respondWith({ active: ['usr-2', 'usr-3'] })
    await expect(createTask({ ...createBase, assignees: ['usr-1', 'usr-2', 'usr-3'] })).resolves.toMatchObject({ version: 1 })
    const lockAt = indexOf('pg_advisory_xact_lock')
    const lookupAt = indexOf('FROM user_orgs')
    const insertAt = state.calls.findIndex((call) => /^\s*INSERT/.test(call.sql))
    expect(sqls()[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(lockAt).toBeGreaterThan(0)
    expect(lookupAt).toBeGreaterThan(lockAt)
    expect(insertAt).toBeGreaterThan(lookupAt)
    expect(written()).toEqual(['INSERT INTO tasks', 'INSERT INTO task_assignees', 'INSERT INTO task_events'])
    // The login test, by column.
    const lookup = sqls()[lookupAt] ?? ''
    for (const fragment of [
      'uo.org_id = $1', 'uo.user_id = ANY($2::text[])', 'uo.is_active = true', 'u.is_active = true', 'JOIN users u ON u.id = uo.user_id',
      "u.activation_status = 'activated'", "(u.role <> 'disabled' OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin'))",
    ]) {
      expect(lookup).toContain(fragment)
    }
  })

  it('createTask: omitting assignees, naming only the creator, or naming nobody sends no lookup', async () => {
    respondWith({ active: [] })
    for (const assignees of [undefined, ['usr-1'], [], ['usr-1', 'usr-1']]) {
      state.calls.length = 0
      await expect(createTask({ ...createBase, assignees })).resolves.toMatchObject({ version: 1 })
      expect(lookups(), JSON.stringify(assignees)).toEqual([])
    }
  })

  it('createTask: the lookup asks for every id but the creator whatever the order (the creator after another id, absent, or in the middle)', async () => {
    respondWith({ active: [] })
    const cases: Array<[string[], string[]]> = [
      [['usr-2', 'usr-1'], ['usr-2']],
      [['usr-2'], ['usr-2']],
      [['usr-3', 'usr-1', 'usr-2'], ['usr-3', 'usr-2']],
    ]
    for (const [assignees, asked] of cases) {
      state.calls.length = 0
      await expect(createTask({ ...createBase, assignees }))
        .rejects.toMatchObject({ status: 422, code: 'INACTIVE_ORG_MEMBER' })
      expect(lookups(), JSON.stringify(assignees)).toHaveLength(1)
      expect(lookups()[0]?.params, JSON.stringify(assignees)).toEqual(['org-1', asked])
      expect(written(), JSON.stringify(assignees)).toEqual([])
    }
  })

  it.each([
    ['addAssignee', 'INSERT INTO task_assignees'],
    ['addFollower', 'INSERT INTO task_followers'],
  ] as const)('%s: the lookup of the target runs after the member reads and before the INSERT; a negative answer is 422 with nothing written', async (name, insert) => {
    const call = () => (name === 'addAssignee' ? addAssignee : addFollower)({ ...memberBase, body: { userId: 'usr-2' } })
    respondWith({ createdBy: 'usr-1', active: [] })
    await expect(call()).rejects.toMatchObject({ status: 422, code: 'INACTIVE_ORG_MEMBER' })
    expect(lookups()).toHaveLength(1)
    expect(lookups()[0]?.params).toEqual(['org-1', ['usr-2']])
    expect(written()).toEqual([])

    state.calls.length = 0
    respondWith({ createdBy: 'usr-1', active: ['usr-2'] })
    await expect(call()).resolves.toBeDefined()
    const lookupAt = indexOf('FROM user_orgs')
    expect(lookupAt).toBeGreaterThan(indexOf('FROM task_assignees'))
    expect(lookupAt).toBeGreaterThan(indexOf('FROM task_followers'))
    expect(state.calls.findIndex((c) => c.sql.includes(insert))).toBeGreaterThan(lookupAt)
    expect(written()).toEqual([insert, 'INSERT INTO task_events'])
  })

  it.each(['addAssignee', 'addFollower'] as const)('%s: a re-add, the caller naming themselves, a full task, a malformed id and a caller without a direct role send no lookup', async (name) => {
    const add = name === 'addAssignee' ? addAssignee : addFollower
    const existing = name === 'addAssignee' ? { assignees: ['usr-2'] } : { followers: ['usr-2'] }
    const full = Array.from({ length: 50 }, (_, i) => `usr-f${i}`)

    // A re-add of a member the lookup would reject: the no-op, nothing written.
    respondWith({ createdBy: 'usr-1', ...existing, active: [] })
    await expect(add({ ...memberBase, body: { userId: 'usr-2' } })).resolves.toBeDefined()
    expect(lookups()).toEqual([])
    expect(written()).toEqual([])

    // The caller naming themselves ([own-16]): written without a lookup.
    state.calls.length = 0
    respondWith({ createdBy: 'usr-1', active: [] })
    await expect(add({ ...memberBase, body: { userId: 'usr-1' } })).resolves.toBeDefined()
    expect(lookups()).toEqual([])
    expect(written()).toHaveLength(2)

    // LIMIT and a malformed id are answered before the lookup.
    state.calls.length = 0
    respondWith({ createdBy: 'usr-1', ...(name === 'addAssignee' ? { assignees: full } : { followers: full }), active: [] })
    await expect(add({ ...memberBase, body: { userId: 'usr-2' } })).rejects.toMatchObject({ status: 422, code: 'LIMIT' })
    await expect(add({ ...memberBase, body: { userId: '..' } })).rejects.toMatchObject({ status: 422, code: 'INVALID_ASSIGNEES' })
    expect(lookups()).toEqual([])

    // [own-53]: no direct role is the 404 before the lookup, even for an active target.
    state.calls.length = 0
    respondWith({ createdBy: 'usr-0', assignees: ['usr-3'], active: ['usr-2'] })
    await expect(add({ ...memberBase, body: { userId: 'usr-2' } })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(lookups()).toEqual([])
    expect(written()).toEqual([])
  })
})
