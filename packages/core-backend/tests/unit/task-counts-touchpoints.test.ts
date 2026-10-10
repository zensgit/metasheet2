/**
 * M4 PR-3c (design task-m4-pr3c-backend-design-20261008.md §3, §4.2, §7.1): the eight service
 * functions that change an input of the pending predicate send `tasks:counts-updated` only after
 * their transaction committed, to the assignees before and after the write.
 *
 * `src/db/pg` is mocked as in task-records-guards.test.ts. The mocked `transaction` writes BEGIN,
 * runs the handler, then writes COMMIT (or, with `failCommit`, throws after the handler as a failed
 * COMMIT does); the send port writes `EMIT <room>` into the same log. A send that happened inside
 * the transaction would sit before COMMIT in the log, or appear although COMMIT failed.
 *
 * The census cell at the end reads the service sources: every function that writes a column the
 * pending predicate reads is one of the eight (or a write helper only they call), and each of the
 * eight takes a signal collector and publishes it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAuthenticatedUserRoom } from '../../src/services/CollabService'
import { resetTaskCountsBroadcasterForTests, setTaskCountsBroadcaster } from '../../src/services/task-counts-realtime'
import { patchTask } from '../../src/services/task-patch'
import { completeTask, createTask, reopenTask } from '../../src/services/task-records'
import { addAssignee, deleteTaskById, removeAssignee, switchCompletionMode } from '../../src/services/task-structure'
import { patchChangesPendingInputs } from '../../src/tasks/task-realtime'

type MockRows = { rows: Record<string, unknown>[] }

const state = vi.hoisted(() => ({
  log: [] as string[],
  failCommit: false,
  respond: undefined as undefined | ((sql: string, params?: unknown[]) => { rows: Record<string, unknown>[] } | undefined),
}))

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => state.respond?.(sql, params) ?? { rows: [] }),
  transaction: vi.fn(async (handler: (client: { query: (sql: string, params?: unknown[]) => Promise<MockRows> }) => Promise<unknown>) => {
    state.log.push('BEGIN')
    const result = await handler({
      query: async (sql: string, params?: unknown[]) => state.respond?.(sql, params) ?? { rows: [] },
    })
    if (state.failCommit) {
      state.log.push('COMMIT FAILED')
      throw Object.assign(new Error('commit failed'), { code: '40001' })
    }
    state.log.push('COMMIT')
    return result
  }),
}))

interface Seed {
  createdBy: string
  mode?: 'all' | 'any'
  status?: 'open' | 'done'
  assignees?: Array<{ userId: string; completedAt?: Date | null }>
  followers?: string[]
  /** Users the org lookup answers as active members. */
  active?: string[]
  /** The task row is gone (every task read returns no row). */
  missing?: boolean
  /** Live children of the task (the delete answers 409 HAS_CHILDREN). */
  children?: string[]
  /** The task's stored time zone (none by default). */
  timeZone?: string
}

const DONE_AT = new Date('2026-10-08T01:00:00.000Z')

function respondWith(seed: Seed): void {
  state.respond = (raw, params) => {
    const sql = raw.replace(/\s+/g, ' ').trim()
    if (sql.startsWith('UPDATE tasks AS t SET title')) return { rows: [{ version: 2 }] }
    if (/^(INSERT|UPDATE|DELETE)/.test(sql)) return undefined
    if (sql.startsWith('SELECT current_setting')) return { rows: [{ value: '0' }] }
    if (seed.missing && /FROM tasks WHERE/.test(sql)) return { rows: [] }
    if (sql.startsWith('SELECT 1 FROM tasks WHERE')) return { rows: [{ one: 1 }] }
    if (sql.startsWith('SELECT id FROM tasks WHERE parent_id')) return { rows: (seed.children ?? []).map((id) => ({ id })) }
    if (sql.startsWith('SELECT created_by FROM tasks WHERE')) return { rows: [{ created_by: seed.createdBy }] }
    if (sql.startsWith('SELECT id, created_by, version, title')) {
      return {
        rows: [{
          id: 'tsk_1', created_by: seed.createdBy, version: 1, title: 'title', description: null,
          due_date: null, due_time: null, start_date: null, start_time: null, time_zone: seed.timeZone ?? null, due_at: null, remind_at: null,
        }],
      }
    }
    if (sql.startsWith('SELECT created_by, completion_mode, status')) {
      return { rows: [{ created_by: seed.createdBy, completion_mode: seed.mode ?? 'all', status: seed.status ?? 'open', parent_id: null, depth: 0, version: 1 }] }
    }
    if (sql.includes('FROM task_assignees')) {
      return { rows: (seed.assignees ?? []).map((row) => ({ user_id: row.userId, completed_at: row.completedAt ?? null })) }
    }
    if (sql.includes('FROM task_followers')) return { rows: (seed.followers ?? []).map((user_id) => ({ user_id })) }
    if (sql.includes('JOIN task_list_members tlm')) return { rows: [] }
    if (sql.includes('FROM user_orgs')) {
      const asked = params?.[1] as string[] | undefined
      return { rows: (seed.active ?? []).filter((id) => (asked ?? []).includes(id)).map((user_id) => ({ user_id })) }
    }
    return undefined
  }
}

const ORG = 'org-1'
const TASK = 'tsk_1'

/** The rooms sent to, in order; every EMIT must come after COMMIT and none after a failed COMMIT. */
function emitted(): string[] {
  return state.log.filter((entry) => entry.startsWith('EMIT ')).map((entry) => entry.slice('EMIT '.length))
}

function expectEmitsAfterCommit(rooms: string[]): void {
  const commit = state.log.indexOf('COMMIT')
  expect(commit).toBeGreaterThanOrEqual(0)
  expect(state.log.slice(commit + 1)).toEqual(rooms.map((room) => `EMIT ${room}`))
  expect(state.log.slice(0, commit).some((entry) => entry.startsWith('EMIT '))).toBe(false)
}

function roomsOf(...userIds: string[]): string[] {
  return userIds.map(buildAuthenticatedUserRoom)
}

beforeEach(() => {
  state.log.length = 0
  state.failCommit = false
  state.respond = undefined
  setTaskCountsBroadcaster((room) => {
    state.log.push(`EMIT ${room}`)
  })
})

afterEach(() => {
  resetTaskCountsBroadcasterForTests()
})

interface Touchpoint {
  name: string
  seed: Seed
  run: () => Promise<unknown>
  /** Users expected to receive, sorted. */
  recipients: string[]
  /** A seed and call that throw inside the transaction (no send). */
  failing: { seed: Seed; run: () => Promise<unknown>; status: number; code: string }
  /** A seed and call that commit but change nothing the predicate reads (no send). */
  noop?: { seed: Seed; run: () => Promise<unknown> }
}

const A = 'usr-a'
const B = 'usr-b'
const C = 'usr-c'
const F = 'usr-f'

const TOUCHPOINTS: Touchpoint[] = [
  {
    name: 'createTask',
    seed: { createdBy: C, active: [A, B] },
    run: () => createTask({ orgId: ORG, creatorId: C, title: 'title', assignees: [A, B] }),
    recipients: [A, B],
    failing: {
      seed: { createdBy: C, active: [A] },
      run: () => createTask({ orgId: ORG, creatorId: C, title: 'title', assignees: [A, B] }),
      status: 422,
      code: 'INACTIVE_ORG_MEMBER',
    },
    noop: { seed: { createdBy: C }, run: () => createTask({ orgId: ORG, creatorId: C, title: 'title', assignees: [] }) },
  },
  {
    name: 'completeTask',
    seed: { createdBy: C, assignees: [{ userId: A }, { userId: B }], followers: [F] },
    run: () => completeTask({ orgId: ORG, actorId: A, taskId: TASK }),
    recipients: [A, B],
    failing: { seed: { createdBy: C, missing: true }, run: () => completeTask({ orgId: ORG, actorId: A, taskId: TASK }), status: 404, code: 'NOT_FOUND' },
    noop: {
      seed: { createdBy: C, assignees: [{ userId: A, completedAt: DONE_AT }, { userId: B }], followers: [F] },
      run: () => completeTask({ orgId: ORG, actorId: A, taskId: TASK }),
    },
  },
  {
    name: 'reopenTask',
    seed: { createdBy: C, assignees: [{ userId: A, completedAt: DONE_AT }, { userId: B }], followers: [F] },
    run: () => reopenTask({ orgId: ORG, actorId: A, taskId: TASK, scope: 'self' }),
    recipients: [A, B],
    failing: { seed: { createdBy: C, missing: true }, run: () => reopenTask({ orgId: ORG, actorId: A, taskId: TASK, scope: 'self' }), status: 404, code: 'NOT_FOUND' },
    noop: {
      seed: { createdBy: C, assignees: [{ userId: A }, { userId: B }], followers: [F] },
      run: () => reopenTask({ orgId: ORG, actorId: A, taskId: TASK, scope: 'self' }),
    },
  },
  {
    name: 'addAssignee',
    seed: { createdBy: C, assignees: [{ userId: A }], followers: [F], active: [B] },
    run: () => addAssignee({ orgId: ORG, actorId: C, taskId: TASK, body: { userId: B } }),
    recipients: [A, B],
    failing: {
      seed: { createdBy: C, assignees: [{ userId: A }], followers: [F], active: [] },
      run: () => addAssignee({ orgId: ORG, actorId: C, taskId: TASK, body: { userId: B } }),
      status: 422,
      code: 'INACTIVE_ORG_MEMBER',
    },
    noop: {
      seed: { createdBy: C, assignees: [{ userId: A }], followers: [F] },
      run: () => addAssignee({ orgId: ORG, actorId: C, taskId: TASK, body: { userId: A } }),
    },
  },
  {
    name: 'removeAssignee',
    seed: { createdBy: C, assignees: [{ userId: A }, { userId: B }], followers: [F] },
    run: () => removeAssignee({ orgId: ORG, actorId: C, taskId: TASK, userId: A }),
    recipients: [A, B],
    failing: {
      seed: { createdBy: C, assignees: [{ userId: A }], followers: [F] },
      run: () => removeAssignee({ orgId: ORG, actorId: F, taskId: TASK, userId: A }),
      status: 404,
      code: 'NOT_FOUND',
    },
    noop: {
      seed: { createdBy: C, assignees: [{ userId: A }], followers: [F] },
      run: () => removeAssignee({ orgId: ORG, actorId: C, taskId: TASK, userId: B }),
    },
  },
  {
    name: 'switchCompletionMode',
    seed: { createdBy: C, assignees: [{ userId: A }, { userId: B }], followers: [F] },
    run: () => switchCompletionMode({ orgId: ORG, actorId: C, taskId: TASK, body: { completionMode: 'any' } }),
    recipients: [A, B],
    failing: {
      seed: { createdBy: C, assignees: [{ userId: A }], followers: [F] },
      run: () => switchCompletionMode({ orgId: ORG, actorId: C, taskId: TASK, body: { completionMode: 'some' } }),
      status: 422,
      code: 'INVALID_MODE',
    },
    noop: {
      seed: { createdBy: C, assignees: [{ userId: A }, { userId: B }], followers: [F] },
      run: () => switchCompletionMode({ orgId: ORG, actorId: C, taskId: TASK, body: { completionMode: 'all' } }),
    },
  },
  {
    name: 'deleteTaskById',
    // A has completed: still an assignee, still a recipient.
    seed: { createdBy: C, assignees: [{ userId: A, completedAt: DONE_AT }, { userId: B }], followers: [F] },
    run: () => deleteTaskById({ orgId: ORG, actorId: C, taskId: TASK }),
    recipients: [A, B],
    failing: {
      seed: { createdBy: C, assignees: [{ userId: A }], followers: [F], children: ['tsk_child'] },
      run: () => deleteTaskById({ orgId: ORG, actorId: C, taskId: TASK }),
      status: 409,
      code: 'HAS_CHILDREN',
    },
    noop: { seed: { createdBy: C, followers: [F] }, run: () => deleteTaskById({ orgId: ORG, actorId: C, taskId: TASK }) },
  },
  {
    name: 'patchTask',
    seed: { createdBy: C, assignees: [{ userId: A }, { userId: B }], followers: [F] },
    run: () => patchTask({ orgId: ORG, actorId: C, taskId: TASK, body: { expectedVersion: 1, dueDate: '2026-10-09', timeZone: 'Asia/Shanghai' } }),
    recipients: [A, B],
    failing: {
      seed: { createdBy: C, assignees: [{ userId: A }], followers: [F] },
      run: () => patchTask({ orgId: ORG, actorId: C, taskId: TASK, body: { expectedVersion: 2, dueDate: '2026-10-09', timeZone: 'Asia/Shanghai' } }),
      status: 409,
      code: 'VERSION_CONFLICT',
    },
    noop: {
      seed: { createdBy: C, assignees: [{ userId: A }, { userId: B }], followers: [F] },
      run: () => patchTask({ orgId: ORG, actorId: C, taskId: TASK, body: { expectedVersion: 1, title: 'another title' } }),
    },
  },
]

describe('tasks:counts-updated touchpoints (M4 PR-3c)', () => {
  it('the table names the eight functions of design §3, once each', () => {
    expect(TOUCHPOINTS.map((touchpoint) => touchpoint.name).sort()).toEqual([
      'addAssignee', 'completeTask', 'createTask', 'deleteTaskById', 'patchTask', 'removeAssignee', 'reopenTask', 'switchCompletionMode',
    ])
  })

  it.each(TOUCHPOINTS.map((touchpoint) => [touchpoint.name, touchpoint] as const))(
    '%s: a committed write sends once per assignee before or after it, every send after COMMIT, never to the follower',
    async (_name, touchpoint) => {
      respondWith(touchpoint.seed)
      await touchpoint.run()
      expectEmitsAfterCommit(roomsOf(...touchpoint.recipients))
      expect(emitted()).not.toContain(buildAuthenticatedUserRoom(F))
    },
  )

  it.each(TOUCHPOINTS.map((touchpoint) => [touchpoint.name, touchpoint] as const))(
    '%s: a failed COMMIT sends nothing and the error reaches the caller',
    async (_name, touchpoint) => {
      respondWith(touchpoint.seed)
      state.failCommit = true
      await expect(touchpoint.run()).rejects.toThrow('commit failed')
      expect(state.log).toContain('COMMIT FAILED')
      expect(emitted()).toEqual([])
    },
  )

  it.each(TOUCHPOINTS.map((touchpoint) => [touchpoint.name, touchpoint] as const))(
    '%s: a write that fails inside its transaction (or before it) sends nothing',
    async (_name, touchpoint) => {
      respondWith(touchpoint.failing.seed)
      await expect(touchpoint.failing.run()).rejects.toMatchObject({ status: touchpoint.failing.status, code: touchpoint.failing.code })
      expect(state.log).not.toContain('COMMIT')
      expect(emitted()).toEqual([])
    },
  )

  it.each(TOUCHPOINTS.filter((touchpoint) => touchpoint.noop).map((touchpoint) => [touchpoint.name, touchpoint] as const))(
    '%s: a write that changes no input of the pending predicate commits and sends nothing',
    async (_name, touchpoint) => {
      respondWith(touchpoint.noop!.seed)
      await touchpoint.noop!.run()
      expect(emitted()).toEqual([])
    },
  )

  it('removeAssignee: the removed assignee is a recipient even when nobody is left', async () => {
    respondWith({ createdBy: C, assignees: [{ userId: A }], followers: [F] })
    await removeAssignee({ orgId: ORG, actorId: C, taskId: TASK, userId: A })
    expectEmitsAfterCommit(roomsOf(A))
  })

  it('addAssignee: the first assignee of a task with none is the only recipient', async () => {
    respondWith({ createdBy: C, followers: [F], active: [B] })
    await addAssignee({ orgId: ORG, actorId: C, taskId: TASK, body: { userId: B } })
    expectEmitsAfterCommit(roomsOf(B))
  })

  it('createTask: omitting assignees makes the creator the one recipient', async () => {
    respondWith({ createdBy: C })
    await createTask({ orgId: ORG, creatorId: C, title: 'title', assignees: undefined })
    expectEmitsAfterCommit(roomsOf(C))
  })

  it('completeTask by the creator of a task without assignees commits and sends nothing', async () => {
    respondWith({ createdBy: C, followers: [F] })
    await completeTask({ orgId: ORG, actorId: C, taskId: TASK })
    expect(state.log).toContain('COMMIT')
    expect(emitted()).toEqual([])
  })

  it('switchCompletionMode: a switch that completes the task sends to every assignee', async () => {
    respondWith({ createdBy: C, assignees: [{ userId: A, completedAt: DONE_AT }, { userId: B }], followers: [F] })
    await switchCompletionMode({ orgId: ORG, actorId: C, taskId: TASK, body: { completionMode: 'any' } })
    expectEmitsAfterCommit(roomsOf(A, B))
  })

  it('patchTask: a time-zone change on a task without a due date sends ([own-3c-03]); a reminder change does not', async () => {
    respondWith({ createdBy: C, assignees: [{ userId: A }], followers: [F] })
    await patchTask({ orgId: ORG, actorId: C, taskId: TASK, body: { expectedVersion: 1, timeZone: 'Asia/Tokyo' } })
    expectEmitsAfterCommit(roomsOf(A))
    state.log.length = 0
    await patchTask({ orgId: ORG, actorId: C, taskId: TASK, body: { expectedVersion: 1, remindAt: '2026-10-09T01:00:00Z' } })
    expect(state.log).toContain('COMMIT')
    expect(emitted()).toEqual([])
  })

  it.each([
    ['the description', { description: 'another description' }],
    ['the start date and time (the stored zone sent again)', { startDate: '2026-10-08', startTime: '08:00', timeZone: 'Asia/Shanghai' }],
  ] as const)('patchTask: an edit of %s alone commits and sends nothing ([own-3c-03])', async (_label, body) => {
    respondWith({ createdBy: C, assignees: [{ userId: A }], followers: [F], timeZone: 'Asia/Shanghai' })
    // A real write: the version comes from the UPDATE (the mock answers 2), not the no-op's 1.
    await expect(patchTask({ orgId: ORG, actorId: C, taskId: TASK, body: { expectedVersion: 1, ...body } })).resolves.toEqual({ id: TASK, version: 2 })
    expect(state.log).toContain('COMMIT')
    expect(emitted()).toEqual([])
  })
})

// RULED(2026-10-07): [R16] every assignee before or after the write. ASSUMPTION(task-m4):
// [own-3c-09] the operator is not left out. In the TOUCHPOINTS rows the operator of these five
// writers is never an assignee, so each row here makes the operator one.
const OPERATOR_IS_ASSIGNEE: Array<{ name: string; seed: Seed; run: () => Promise<unknown>; recipients: string[] }> = [
  {
    name: 'addAssignee: the creator adds themselves',
    seed: { createdBy: C, assignees: [{ userId: A }], followers: [F] },
    run: () => addAssignee({ orgId: ORG, actorId: C, taskId: TASK, body: { userId: C } }),
    recipients: [A, C],
  },
  {
    name: 'removeAssignee: a creator who is an assignee removes themselves',
    seed: { createdBy: C, assignees: [{ userId: A }, { userId: C }], followers: [F] },
    run: () => removeAssignee({ orgId: ORG, actorId: C, taskId: TASK, userId: C }),
    recipients: [A, C],
  },
  {
    name: 'switchCompletionMode: a creator who is an assignee switches all to any after A completed',
    seed: { createdBy: C, assignees: [{ userId: C }, { userId: A, completedAt: DONE_AT }], followers: [F] },
    run: () => switchCompletionMode({ orgId: ORG, actorId: C, taskId: TASK, body: { completionMode: 'any' } }),
    recipients: [A, C],
  },
  {
    name: 'deleteTaskById: the creator deletes their own task, of which they are the one assignee',
    seed: { createdBy: C, assignees: [{ userId: C }], followers: [F] },
    run: () => deleteTaskById({ orgId: ORG, actorId: C, taskId: TASK }),
    recipients: [C],
  },
  {
    name: 'patchTask: a creator who is an assignee moves the due date (the other assignee has completed)',
    seed: { createdBy: C, assignees: [{ userId: C }, { userId: A, completedAt: DONE_AT }], followers: [F] },
    run: () => patchTask({ orgId: ORG, actorId: C, taskId: TASK, body: { expectedVersion: 1, dueDate: '2026-10-09', timeZone: 'Asia/Shanghai' } }),
    recipients: [A, C],
  },
]

describe('tasks:counts-updated: the operator who is an assignee is a recipient (M4 PR-3c, [own-3c-09])', () => {
  it.each(OPERATOR_IS_ASSIGNEE.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    respondWith(row.seed)
    await row.run()
    expectEmitsAfterCommit(roomsOf(...row.recipients))
    expect(emitted()).not.toContain(buildAuthenticatedUserRoom(F))
  })
})

describe('patchChangesPendingInputs (M4 PR-3c, [own-3c-03])', () => {
  const base = { dueDate: '2026-10-09', dueTime: '09:00:00', timeZone: 'Asia/Shanghai', dueAt: new Date('2026-10-09T01:00:00.000Z') }

  it('nothing changed: false (a new Date of the same instant is the same)', () => {
    expect(patchChangesPendingInputs(base, { ...base, dueAt: new Date(base.dueAt.getTime()) })).toBe(false)
  })

  it.each([
    ['dueDate', { dueDate: '2026-10-10' }],
    ['dueDate cleared', { dueDate: null }],
    ['dueTime', { dueTime: '10:00:00' }],
    ['dueTime cleared', { dueTime: null }],
    ['timeZone', { timeZone: 'Asia/Tokyo' }],
    ['timeZone cleared', { timeZone: null }],
    ['dueAt', { dueAt: new Date('2026-10-09T02:00:00.000Z') }],
    ['dueAt cleared', { dueAt: null }],
  ] as const)('%s changed: true', (_label, change) => {
    expect(patchChangesPendingInputs(base, { ...base, ...change })).toBe(true)
  })

  it('a time zone set on a task without a due date: true', () => {
    const none = { dueDate: null, dueTime: null, timeZone: null, dueAt: null }
    expect(patchChangesPendingInputs(none, { ...none, timeZone: 'Asia/Tokyo' })).toBe(true)
    expect(patchChangesPendingInputs(none, { ...none })).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Census (design §2.3): the writers of the pending predicate's inputs, read from the sources.
// ---------------------------------------------------------------------------------------------

const SRC_DIR = join(__dirname, '../../src')
const SERVICES_DIR = join(SRC_DIR, 'services')

/**
 * A table as SQL names it: optionally schema-qualified (`public.tasks`), optionally quoted. SQL
 * keywords are matched in upper case only, as src writes them: matched without case, prose such as
 * a permission description ("update tasks") would read as a write.
 */
function tableRef(name: string): string {
  return String.raw`(?:"?[A-Za-z_]\w*"?\.)?"?${name}"?(?![\w"])`
}

/** `ONLY`, which may stand between `UPDATE` or `DELETE FROM` and the table. */
const ONLY = String.raw`(?:ONLY\s+)?`

/** A SQL write of a column the pending predicate reads (design §2.2); any white space between words. */
const INPUT_WRITE = [
  String.raw`\bINSERT\s+INTO\s+${tableRef('task_assignees')}`,
  String.raw`\bDELETE\s+FROM\s+${ONLY}${tableRef('task_assignees')}`,
  String.raw`\bUPDATE\s+${ONLY}${tableRef('task_assignees')}`,
  String.raw`\bINSERT\s+INTO\s+${tableRef('tasks')}`,
  // A hard delete of a task row removes its assignee rows too (the foreign key cascades).
  String.raw`\bDELETE\s+FROM\s+${ONLY}${tableRef('tasks')}`,
].map((source) => new RegExp(source, 'g'))
/** An update of the task table, with its text up to `WHERE` (or to the end of the source). */
const TASKS_UPDATE = new RegExp(String.raw`\bUPDATE\s+${ONLY}${tableRef('tasks')}([\s\S]*?)(?:\bWHERE\b|$)`, 'g')
const INPUT_COLUMN = String.raw`(?:status|completed_at|deleted_at|due_date|due_time|due_at|time_zone|org_id)`
/** An input column set alone (`status = …`) or inside a parenthesised list (`SET (title, status) = …`). */
const INPUT_COLUMNS = new RegExp(String.raw`\b${INPUT_COLUMN}"?\s*=|\([^()]*\b${INPUT_COLUMN}\b[^()]*\)\s*=`)

const TOUCHPOINT_NAMES = [
  'createTask', 'completeTask', 'reopenTask', 'addAssignee', 'removeAssignee', 'switchCompletionMode', 'deleteTaskById', 'patchTask',
]
const WRITE_HELPERS = ['writeChangedAssignees', 'writeTaskDoneState', 'writeCompletionModeState']

interface FunctionSpan { name: string; start: number; end: number }

/** A top-level line: it starts in column 0 with neither white space, a closing bracket nor a comment. */
const TOP_LEVEL_LINE = /^(?![\s}\])/*]).+$/gm
const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\s*\*?\s*(\w+)|(?:const|let|var)\s+(\w+)|(?:abstract\s+)?class\s+(\w+))/

/**
 * The top-level spans of a source text: every top-level line starts one, which runs to the next.
 * A span is named after what it declares: `function NAME`, `class NAME`, or `const|let|var NAME`
 * whatever its initializer (an arrow or a function expression, with or without a type annotation).
 * Any other top-level line (a statement, an `export { … }`) names its span `<top level: …>`, so a
 * write there is reported as such instead of being charged to the declaration above it.
 */
function functionSpans(text: string): FunctionSpan[] {
  const starts = [...text.matchAll(TOP_LEVEL_LINE)].map((match) => {
    const declared = DECLARATION.exec(match[0])
    return {
      name: declared ? (declared[1] ?? declared[2] ?? declared[3]) : `<top level: ${match[0].slice(0, 40)}>`,
      start: match.index ?? 0,
    }
  })
  return starts.map((entry, index) => ({ ...entry, end: index + 1 < starts.length ? starts[index + 1].start : text.length }))
}

function enclosing(spans: FunctionSpan[], at: number): string {
  return spans.find((span) => at >= span.start && at < span.end)?.name ?? '<top level>'
}

/** Function names (per file) that hold a write of a pending-predicate input. */
function inputWriters(text: string): string[] {
  const spans = functionSpans(text)
  const names = new Set<string>()
  for (const pattern of INPUT_WRITE) {
    for (const match of text.matchAll(pattern)) names.add(enclosing(spans, match.index ?? 0))
  }
  for (const match of text.matchAll(TASKS_UPDATE)) {
    if (INPUT_COLUMNS.test(match[1])) names.add(enclosing(spans, match.index ?? 0))
  }
  return [...names]
}

function allSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...allSources(path))
    else if (name.endsWith('.ts')) out.push(path)
  }
  return out
}

function serviceSources(): Array<{ file: string; text: string }> {
  return readdirSync(SERVICES_DIR)
    .filter((file) => file.startsWith('task-') && file.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(SERVICES_DIR, file), 'utf8') }))
}

describe('census of the pending-predicate writers (design §2.3)', () => {
  it('the scanner flags every shape of writer it reads and ignores the controls (the patterns are live)', () => {
    const synthetic = [
      'export async function newWriter(db) {',
      "  await db.query(`UPDATE tasks SET status = 'done' WHERE id = $1`, [id])",
      '}',
      'async function assigneeWriter(db) {',
      '  await db.query(`DELETE FROM task_assignees WHERE task_id = $1`, [id])',
      '}',
      'export const arrowWriter = async (db) => {',
      '  await db.query(`UPDATE tasks AS t SET due_at = $2 WHERE t.id = $1`, [id])',
      '}',
      // A touchpoint's name with no write of its own; each writer after it is charged to itself.
      'export async function deleteTaskById(db) {',
      '  return db',
      '}',
      'export const expressionWriter = async function (db) {',
      '  await db.query(`DELETE FROM task_assignees WHERE task_id = $1`, [id])',
      '}',
      'export const annotatedWriter: (db: Db, id: string) => Promise<void> = async (db, id) => {',
      '  await db.query(`UPDATE task_assignees SET completed_at = NULL WHERE task_id = $1`, [id])',
      '}',
      'export class ClassWriter {',
      '  async run(db) { await db.query(`INSERT INTO tasks (id) VALUES ($1)`, [id]) }',
      '}',
      'void registerWriter(async (db) => db.query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [id]))',
      'export async function schemaWriter(db) {',
      '  await db.query(`UPDATE public.task_assignees SET completed_at = NULL WHERE task_id = $1`, [id])',
      '}',
      'export async function quotedWriter(db) {',
      '  await db.query(`UPDATE "public"."tasks" SET "status" = \'done\' WHERE id = $1`, [id])',
      '}',
      'export async function purgeWriter(db) {',
      '  await db.query(`DELETE FROM tasks WHERE id = $1`, [id])',
      '}',
      'export async function splitLineWriter(db) {',
      '  await db.query(`INSERT INTO',
      '    task_assignees (task_id, user_id) VALUES ($1, $2)`, [id, userId])',
      '}',
      'export async function onlyUpdateWriter(db) {',
      "  await db.query(`UPDATE ONLY tasks SET status = 'done' WHERE id = $1`, [id])",
      '}',
      'export async function onlyDeleteWriter(db) {',
      '  await db.query(`DELETE FROM ONLY public.tasks WHERE id = $1`, [id])',
      '}',
      'export async function onlyAssigneeUpdateWriter(db) {',
      '  await db.query(`UPDATE ONLY task_assignees SET completed_at = NULL WHERE task_id = $1`, [id])',
      '}',
      'export async function onlyAssigneeDeleteWriter(db) {',
      '  await db.query(`DELETE FROM ONLY task_assignees WHERE task_id = $1`, [id])',
      '}',
      'export async function rowListWriter(db) {',
      "  await db.query(`UPDATE tasks SET (title, \"status\") = ($2, 'done') WHERE id = $1`, [id])",
      '}',
      // Controls: a parent-only update, a column that is no input (alone or in a list), other tables.
      'export async function parentOnly(db) {',
      '  await db.query(`UPDATE tasks SET parent_id = $2, depth = $3, updated_at = $4 WHERE id = $1`, [id])',
      '  await db.query(`UPDATE tasks SET title = $2 WHERE id = $1`, [id])',
      '  await db.query(`UPDATE ONLY tasks SET (title, updated_at) = ($2, now()) WHERE id = $1`, [id])',
      '}',
      'export async function otherTables(db) {',
      "  await db.query(`UPDATE tasks_archive SET status = 'done' WHERE id = $1`, [id])",
      '  await db.query(`DELETE FROM public.task_followers WHERE task_id = $1`, [id])',
      '  await db.query(`INSERT INTO task_list_items (task_id) VALUES ($1)`, [id])',
      '}',
    ].join('\n')
    const names = inputWriters(synthetic).sort()
    expect(names.filter((name) => !name.startsWith('<'))).toEqual([
      'ClassWriter', 'annotatedWriter', 'arrowWriter', 'assigneeWriter', 'expressionWriter',
      'newWriter', 'onlyAssigneeDeleteWriter', 'onlyAssigneeUpdateWriter', 'onlyDeleteWriter', 'onlyUpdateWriter',
      'purgeWriter', 'quotedWriter', 'rowListWriter', 'schemaWriter', 'splitLineWriter',
    ])
    // A write in a top-level statement is reported under the statement, not under a function.
    const statements = names.filter((name) => name.startsWith('<'))
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^<top level: void registerWriter\(/)
  })

  it('the population: in all of src, only three service files write an input of the pending predicate', () => {
    const files = allSources(SRC_DIR)
    expect(files.length).toBeGreaterThan(100)
    const writers = files
      .filter((path) => inputWriters(readFileSync(path, 'utf8')).length > 0)
      .map((path) => relative(SRC_DIR, path))
      .sort()
    expect(writers).toEqual(['services/task-patch.ts', 'services/task-records.ts', 'services/task-structure.ts'])
  })

  it('every writer of an input is one of the eight touchpoints or a write helper; every helper is called only from touchpoints', () => {
    const writers = new Set<string>()
    for (const { text } of serviceSources()) for (const name of inputWriters(text)) writers.add(name)
    expect([...writers].sort()).toEqual([
      'addAssignee', 'createTask', 'deleteTaskById', 'patchTask', 'removeAssignee',
      'writeChangedAssignees', 'writeCompletionModeState', 'writeTaskDoneState',
    ])
    for (const helper of WRITE_HELPERS) {
      const callers = new Set<string>()
      for (const { text } of serviceSources()) {
        const spans = functionSpans(text)
        for (const match of text.matchAll(new RegExp(`\\b${helper}\\(`, 'g'))) {
          const name = enclosing(spans, match.index ?? 0)
          if (name !== helper) callers.add(name)
        }
      }
      expect(callers.size, helper).toBeGreaterThan(0)
      for (const caller of callers) expect(TOUCHPOINT_NAMES, `${helper} called from ${caller}`).toContain(caller)
    }
  })

  it('each of the eight takes a collector, notes inside its transaction and publishes after it at the top level of the function', () => {
    const bodies = new Map<string, string>()
    for (const { text } of serviceSources()) {
      for (const span of functionSpans(text)) {
        if (TOUCHPOINT_NAMES.includes(span.name)) bodies.set(span.name, text.slice(span.start, span.end))
      }
    }
    expect([...bodies.keys()].sort()).toEqual([...TOUCHPOINT_NAMES].sort())
    for (const [name, body] of bodies) {
      expect(body, name).toMatch(/const counts = taskCountsSignal\(\)/)
      expect(body, name).toMatch(/counts\.note\(/)
      const publishes = [...body.matchAll(/^ {2}counts\.publish\(\)$/gm)]
      expect(publishes, name).toHaveLength(1)
      const transactionAt = Math.max(body.indexOf('withOrgStructure'), body.indexOf('await transaction('))
      expect(transactionAt, name).toBeGreaterThan(0)
      expect(publishes[0].index ?? 0, name).toBeGreaterThan(transactionAt)
      expect(body.indexOf('counts.note('), name).toBeLessThan(publishes[0].index ?? 0)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Emit after commit (design §4.2, rule). `transaction()` resolves once COMMIT returned, and the
// COMMIT of an aborted transaction is answered with a rollback and no error: a statement error
// swallowed inside a writer's callback would let `publish` send for a write that rolled back. So
// in every task module the writers run in, every path out of a `catch` throws, and no construct
// swallows a statement error.
// ---------------------------------------------------------------------------------------------

const WRITER_FILES = ['services/task-patch.ts', 'services/task-records.ts', 'services/task-structure.ts']
/** The after-commit send drops a failed send by design ([own-3c-10]); it runs after the transaction. */
const SWALLOW_ALLOWED: Record<string, string[]> = { 'services/task-counts-realtime.ts': ['sendOne'] }

/**
 * The modules the eight writers run in: the three writer files and, transitively, every task module
 * they import (`services/task-*`, `db/task-*`). `src/tasks` is left out: it holds no I/O (gate 20),
 * so no statement to swallow.
 */
function writerModules(): string[] {
  const seen = new Set<string>()
  const queue = [...WRITER_FILES]
  while (queue.length > 0) {
    const rel = queue.shift() as string
    if (seen.has(rel)) continue
    seen.add(rel)
    for (const match of readFileSync(join(SRC_DIR, rel), 'utf8').matchAll(/\bfrom\s+'(\.{1,2}\/[^']+)'/g)) {
      const target = `${posix.join(posix.dirname(rel), match[1].replace(/\.(?:js|ts)$/, ''))}.ts`
      if (/^(?:services|db)\/task-[^/]+\.ts$/.test(target)) queue.push(target)
    }
  }
  return [...seen].sort()
}

/** The `catch` clause of a `try` statement, up to its opening brace. */
const CATCH_CLAUSE = /\}\s*catch\s*(?:\([^)]*\))?\s*\{/g
/** The `finally` clause of a `try` statement, up to its opening brace. */
const FINALLY_CLAUSE = /\}\s*finally\s*\{/g
/** A statement that leaves a block without throwing. */
const LEAVES_BLOCK = /\b(?:return|break|continue)\b/
/** A promise handler that can take a rejection (on the same line, or chained from the line above). */
const PROMISE_HANDLER = /[\w$)\]](?:[ \t]*\n\s*)?\.\s*(?:catch|then)\s*\(/g
/** A combinator that can resolve while one of the promises it was given rejects. */
const SETTLING_COMBINATOR = /\bPromise\s*\.\s*(?:allSettled|race|any)\b/g
/** A comment line: it starts with `//`, `/*` or `*`. */
const COMMENT_LINE = /^(?:\/\/|\/\*|\*)/

/** The text between the brace at `open` and its partner. */
function blockAt(text: string, open: number): string {
  let depth = 0
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '{') depth += 1
    else if (text[at] === '}' && --depth === 0) return text.slice(open + 1, at)
  }
  return text.slice(open + 1)
}

/** The non-empty, non-comment lines of the block a clause match opens, trimmed. */
function blockStatements(text: string, clause: RegExpMatchArray): string[] {
  const open = (clause.index ?? 0) + clause[0].length - 1
  return blockAt(text, open).split('\n').map((line) => line.trim())
    .filter((line) => line.length > 0 && !COMMENT_LINE.test(line))
}

/** Whether the line that holds offset `at` is a comment line (read from the line start up to `at`). */
function onCommentLine(text: string, at: number): boolean {
  return COMMENT_LINE.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, at).trimStart())
}

/**
 * Where a source text can swallow an error, as the names of the enclosing spans: every `catch`
 * block whose last statement is neither `throw …` nor `fail(…)`, or that holds a `return`, `break`
 * or `continue` anywhere; every `finally` block that holds one of those three; every promise
 * handler; and every `Promise.allSettled`, `Promise.race` or `Promise.any` outside a comment line.
 */
function swallowSites(text: string): string[] {
  const spans = functionSpans(text)
  const sites: string[] = []
  for (const match of text.matchAll(CATCH_CLAUSE)) {
    const statements = blockStatements(text, match)
    const last = statements.at(-1) ?? ''
    if (!/^(?:throw\b|fail\()/.test(last) || statements.some((line) => LEAVES_BLOCK.test(line))) {
      sites.push(enclosing(spans, match.index ?? 0))
    }
  }
  for (const match of text.matchAll(FINALLY_CLAUSE)) {
    if (blockStatements(text, match).some((line) => LEAVES_BLOCK.test(line))) sites.push(enclosing(spans, match.index ?? 0))
  }
  for (const match of text.matchAll(PROMISE_HANDLER)) sites.push(enclosing(spans, match.index ?? 0))
  for (const match of text.matchAll(SETTLING_COMBINATOR)) {
    if (!onCommentLine(text, match.index ?? 0)) sites.push(enclosing(spans, match.index ?? 0))
  }
  return sites
}

describe('emit after commit: no swallowed statement error where the writers run (design §4.2)', () => {
  it('the scan flags each catch with a path out that does not throw, a finally that leaves early, every promise handler and settling combinator, and passes the rest (the patterns are live)', () => {
    const synthetic = [
      'export async function swallows(db) {',
      '  try { await db.query(`SELECT 1`) } catch { /* best effort */ }',
      '}',
      'export async function swallowsUnlessBusy(db) {',
      '  try {',
      '    await db.query(`SELECT 1`)',
      '  } catch (err) {',
      '    if (isBusy(err)) throw err',
      '  }',
      '}',
      'export async function returnsInCatch(db) {',
      '  try {',
      '    await db.query(`SELECT 1`)',
      '  } catch (err) {',
      '    if (isMissing(err)) { rows = []; return }',
      '    throw err',
      '  }',
      '}',
      'export async function breaksInCatch(db) {',
      '  for (const id of ids) {',
      '    try {',
      '      await db.query(`SELECT 1`, [id])',
      '    } catch (err) {',
      '      if (isBusy(err)) break',
      '      throw err',
      '    }',
      '  }',
      '}',
      'export async function continuesInCatch(db) {',
      '  for (const id of ids) {',
      '    try {',
      '      await db.query(`SELECT 1`, [id])',
      '    } catch (err) {',
      '      if (isBusy(err)) continue',
      '      throw err',
      '    }',
      '  }',
      '}',
      'export async function returnsInFinally(db) {',
      '  try {',
      '    await db.query(`SELECT 1`)',
      '  } finally {',
      '    if (done) return',
      '  }',
      '}',
      'export async function promiseCatch(db) {',
      '  await db.query(`SELECT 1`).catch(() => undefined)',
      '}',
      'export async function promiseThen(db) {',
      '  await db.query(`SELECT 1`).then(undefined, () => undefined)',
      '}',
      'export async function chainedCatch(db) {',
      '  await db.query(`SELECT 1`)',
      '    .catch(() => undefined)',
      '}',
      'export async function settlesAll(db) {',
      '  await Promise.allSettled([db.query(`SELECT 1`)])',
      '}',
      'export async function races(db) {',
      '  await Promise.race([db.query(`SELECT 1`), pause()])',
      '}',
      'export async function anyOf(db) {',
      '  await Promise .any([db.query(`SELECT 1`), db.query(`SELECT 2`)])',
      '}',
      // Controls: every path out throws; a finally that only cleans up; a combinator that rejects.
      'export async function rethrows(db) {',
      '  try {',
      '    await db.query(`SELECT 1`)',
      '  } catch (err) {',
      "    if (isBusy(err)) fail(409, 'TASK_BUSY')",
      '    throw err',
      '  }',
      '}',
      'export async function translates(db) {',
      '  try {',
      '    await db.query(`SELECT 1`)',
      '  } catch {',
      "    fail(409, 'TASK_BUSY')",
      '    // nothing after this',
      '  }',
      '}',
      'export async function commentInCatch(db) {',
      '  try {',
      '    await db.query(`SELECT 1`)',
      '  } catch (err) {',
      '    // a comment may say return or continue: it is prose',
      '    throw err',
      '  }',
      '}',
      'export async function cleansUp(db) {',
      '  try {',
      '    await db.query(`SELECT 1`)',
      '  } finally {',
      '    release()',
      '  }',
      '}',
      'export async function awaitsAll(db) {',
      '  await Promise.all([db.query(`SELECT 1`), db.query(`SELECT 2`)])',
      '  // Prose is no site: a comment may name Promise.allSettled( or Promise.race(.',
      '}',
      '// Prose is no site: a comment may say that a `catch` ends in throw, or name a .catch( call.',
    ].join('\n')
    expect(swallowSites(synthetic).sort()).toEqual([
      'anyOf', 'breaksInCatch', 'chainedCatch', 'continuesInCatch', 'promiseCatch', 'promiseThen', 'races',
      'returnsInCatch', 'returnsInFinally', 'settlesAll', 'swallows', 'swallowsUnlessBusy',
    ])
  })

  it('in every task module the eight writers run in, every path out of a catch throws and no construct swallows a statement error, except the after-commit send', () => {
    const modules = writerModules()
    // The import walk is live: modules reached only through an import, one of them across `..`.
    expect(modules).toEqual(expect.arrayContaining([
      ...WRITER_FILES, 'services/task-counts-realtime.ts', 'services/task-create.ts', 'services/task-ids-runtime.ts',
      'services/task-org-members.ts', 'services/task-user-settings.ts', 'db/task-advisory-locks.ts',
    ]))
    const found: string[] = []
    for (const rel of modules) {
      const sites = swallowSites(readFileSync(join(SRC_DIR, rel), 'utf8'))
      for (const name of sites) if (!(SWALLOW_ALLOWED[rel] ?? []).includes(name)) found.push(`${rel}: ${name}`)
      // An allowed site still exists (the exception is not stale).
      for (const name of SWALLOW_ALLOWED[rel] ?? []) expect(sites, `${rel}: ${name}`).toContain(name)
    }
    expect(found).toEqual([])
  })
})
