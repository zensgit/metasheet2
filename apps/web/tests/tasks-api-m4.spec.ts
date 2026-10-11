import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Task-feature-line M4 frontend API client tests (frontend design
 * `docs/development/task-m4-frontend-design-20261007.md` §3 / §10.1; backend contract PR-3a
 * `task-m4-pr3a-backend-design-20260930.md` §3, first read at commit 00ddafad23 and re-diffed in
 * FE-8 against the later head named in the verification record). Every route here — settings (S3),
 * `PATCH /api/tasks/:id` (S4), lists (S5), list members (S6), list items (S7), groups (S8), and the
 * detail's `canManageMembers` and the 422 `INACTIVE_ORG_MEMBER` of the task writes (FE-8) — is
 * built on the PR-3a branch, not on main; every cell here mocks `apiFetch` the same way
 * tasks-api.spec.ts does.
 *
 * Also covered: the M4 extensions of the M2 functions (`getTask`'s optional keys, `listTasks`'s
 * page and `total`, `createTask`'s date keys and 422 allowlist, `fetchPendingCount`'s
 * `badgeScope`), the shared paging loop (`collectPages`, exercised through `listTaskListItems`),
 * the refused path segments and the URI encoding of every id position, and the pure pre-check
 * module `tasks/tasksDraft.ts` (design §3.3).
 */

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: h.apiFetch,
}))

import {
  addAssignee,
  addFollower,
  addTaskListMember,
  addTaskToList,
  archiveTaskList,
  changeTaskListMemberRole,
  createTask,
  createTaskList,
  createTaskListGroup,
  createUserGroup,
  CREATE_TASK_VALIDATION_CODES,
  deleteTaskListGroup,
  deleteUserGroup,
  fetchPendingCount,
  getTask,
  getTaskList,
  getTaskSettings,
  listAllTaskLists,
  listTaskListEvents,
  listTaskListGroupItems,
  listTaskListGroups,
  listTaskListItems,
  listTaskListMembers,
  listTaskLists,
  listTasks,
  listUserGroupItems,
  listUserGroups,
  parseTaskGroup,
  parseTaskList,
  parseTaskSettings,
  patchTask,
  patchTaskSettings,
  placeTaskInListGroup,
  placeTaskInUserGroup,
  removeTaskFromList,
  removeTaskListMember,
  renameTaskList,
  renameTaskListGroup,
  renameUserGroup,
  resolveViewerTimeZone,
  TASK_MAX_PAGES,
  TASK_PAGE_LIMIT,
  transferTaskListOwner,
  unarchiveTaskList,
  type TaskDetail,
  type TaskSettings,
} from '../src/tasks/tasksApi'
import {
  buildSettingsPatch,
  buildTaskPatch,
  checkGroupName,
  checkListName,
  checkRemindAt,
  checkSettingsDraft,
  checkTaskDates,
  checkTaskDescription,
  checkTaskTitle,
  createEditorState,
  initDraft,
  initSettingsDraft,
  isValidTimeZoneName,
  rebaseDraft,
  TASK_DESCRIPTION_MAX_CODEPOINTS,
  TASK_NAME_MAX_CODEPOINTS,
  type TaskDraft,
  type TaskDraftSource,
} from '../src/tasks/tasksDraft'

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response
}

function lastCall(): [string, Record<string, unknown> | undefined] {
  const call = h.apiFetch.mock.calls[h.apiFetch.mock.calls.length - 1]
  return [call[0], call[1]]
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(lastCall()[1]?.body as string)
}

function calledPaths(): string[] {
  return h.apiFetch.mock.calls.map((call) => call[0] as string)
}

beforeEach(() => {
  h.apiFetch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------------------------
// Fixtures: the contract's success bodies.
// ---------------------------------------------------------------------------------------------

const ISO = '2026-10-07T00:00:00.000Z'

const settingsBody = {
  badgeScope: 'overdue',
  dailyReminderEnabled: false,
  defaultRemindPolicy: { mode: 'default' },
  timeZone: null,
}

const listBody = {
  id: 'tlst_1',
  name: 'Launch',
  createdBy: 'u1',
  ownerId: 'u1',
  archivedAt: null,
  createdAt: ISO,
  updatedAt: ISO,
  myRole: 'owner',
}

const eventBody = {
  id: 'tlev_1',
  listId: 'tlst_1',
  actorId: 'u1',
  eventType: 'created',
  payload: {},
  occurredAt: ISO,
}

const memberBody = { userId: 'u2', role: 'edit', createdAt: ISO }

const itemBody = {
  id: 'tsk_1',
  title: 'x',
  status: 'open',
  completion_mode: 'all',
  created_by: 'u1',
  due_at: null,
}

const listGroupBody = { id: 'tgrp_1', scope: 'list', name: 'Doing', position: 0, isDefault: true }
const userGroupBody = { id: null, scope: 'user', name: '默认分组', position: 0, isDefault: true }
const placementBody = { groupId: 'tgrp_1', taskId: 'tsk_1', position: 0 }

function m2TaskBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    title: 'x',
    status: 'open',
    completionMode: 'all',
    createdBy: 'u1',
    dueAt: null,
    dueDate: null,
    dueTime: null,
    timeZone: null,
    assignees: [],
    canComplete: true,
    canReopen: false,
    ...over,
  }
}

const m4TaskKeys = {
  version: 3,
  description: 'Write the plan',
  startDate: '2031-03-10',
  startTime: '09:00:00',
  remindAt: '2031-03-15T01:30:00.000Z',
  listIds: ['tlst_1', 'tlst_2'],
}

const page = <T extends { id: string }>(template: T, from: number, count: number): T[] =>
  Array.from({ length: count }, (_unused, index) => ({ ...template, id: `${template.id}_${from + index}` }))

// ---------------------------------------------------------------------------------------------
// PATCH /api/tasks/:id
// ---------------------------------------------------------------------------------------------

describe('patchTask', () => {
  it('PATCHes /api/tasks/:id with expectedVersion and the given keys, and resolves ok with id and version', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1', version: 4 }))
    const result = await patchTask('t1', { expectedVersion: 3, title: 'New' })
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1')
    expect(options?.method).toBe('PATCH')
    expect(sentBody()).toStrictEqual({ expectedVersion: 3, title: 'New' })
    expect(result).toStrictEqual({ kind: 'ok', id: 't1', version: 4 })
  })

  it('serializes only the keys given: an undefined key is absent, a null key is sent as null', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1', version: 2 }))
    await patchTask('t1', { expectedVersion: 1, title: undefined, dueDate: null, dueTime: null, timeZone: 'Asia/Shanghai' })
    const body = sentBody()
    expect(Object.keys(body).sort()).toEqual(['dueDate', 'dueTime', 'expectedVersion', 'timeZone'])
    expect(body).toStrictEqual({ expectedVersion: 1, dueDate: null, dueTime: null, timeZone: 'Asia/Shanghai' })
  })

  it('sends every editable key when every one is given', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1', version: 2 }))
    await patchTask('t1', {
      expectedVersion: 1,
      title: 'T',
      description: '',
      dueDate: '2031-03-15',
      dueTime: '10:00',
      startDate: '2031-03-10',
      startTime: '09:00',
      timeZone: 'Asia/Shanghai',
      remindAt: null,
    })
    expect(sentBody()).toStrictEqual({
      expectedVersion: 1,
      title: 'T',
      description: '',
      dueDate: '2031-03-15',
      dueTime: '10:00',
      startDate: '2031-03-10',
      startTime: '09:00',
      timeZone: 'Asia/Shanghai',
      remindAt: null,
    })
  })

  it('URI-encodes the id', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't 1', version: 2 }))
    await patchTask('t 1', { expectedVersion: 1 })
    expect(lastCall()[0]).toBe('/api/tasks/t%201')
  })

  it.each([
    ['missing version', { id: 't1' }],
    ['version 0', { id: 't1', version: 0 }],
    ['negative version', { id: 't1', version: -1 }],
    ['fractional version', { id: 't1', version: 1.5 }],
    ['string version', { id: 't1', version: '2' }],
    ['missing id', { version: 2 }],
    ['null body', null],
  ])('resolves error for a malformed 200 body: %s', async (_label, body) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(patchTask('t1', { expectedVersion: 1 })).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves not_found for a 404 and forbidden for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND' } }))
    await expect(patchTask('t1', { expectedVersion: 1 })).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(patchTask('t1', { expectedVersion: 1 })).resolves.toEqual({ kind: 'forbidden' })
  })

  it('resolves org_missing for a 422 ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(patchTask('t1', { expectedVersion: 1 })).resolves.toEqual({ kind: 'org_missing' })
  })

  it.each([
    'INVALID_VERSION',
    'INVALID_TITLE',
    'INVALID_DESCRIPTION',
    'INVALID_DATE',
    'INVALID_TIME_ZONE',
    'TIME_ZONE_REQUIRED',
    'INVALID_REMIND_AT',
  ])('resolves validation %s for a 422 with that code', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(patchTask('t1', { expectedVersion: 1 })).resolves.toEqual({ kind: 'validation', code })
  })

  it('resolves error for a 422 with no parseable code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, {}))
    await expect(patchTask('t1', { expectedVersion: 1 })).resolves.toEqual({ kind: 'error', status: 422 })
  })

  it('resolves conflict VERSION_CONFLICT with currentVersion from the 409 body', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(409, { error: { code: 'VERSION_CONFLICT' }, currentVersion: 2 }))
    await expect(patchTask('t1', { expectedVersion: 1 })).resolves.toStrictEqual({
      kind: 'conflict',
      code: 'VERSION_CONFLICT',
      currentVersion: 2,
    })
  })

  it('resolves conflict without a currentVersion key when the 409 body has none', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(409, { error: { code: 'VERSION_CONFLICT' } }))
    const result = await patchTask('t1', { expectedVersion: 1 })
    expect(result).toStrictEqual({ kind: 'conflict', code: 'VERSION_CONFLICT' })
    expect('currentVersion' in result).toBe(false)
  })

  it.each([
    ['0', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '2'],
    ['null', null],
  ])('resolves conflict without a currentVersion key when the 409 body carries a non-positive-integer one: %s', async (_label, value) => {
    h.apiFetch.mockResolvedValue(jsonResponse(409, { error: { code: 'VERSION_CONFLICT' }, currentVersion: value }))
    const result = await patchTask('t1', { expectedVersion: 1 })
    expect(result).toStrictEqual({ kind: 'conflict', code: 'VERSION_CONFLICT' })
    expect('currentVersion' in result).toBe(false)
  })

  it('resolves error for a 409 with no parseable code (even with a currentVersion)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(409, { currentVersion: 2 }))
    await expect(patchTask('t1', { expectedVersion: 1 })).resolves.toEqual({ kind: 'error', status: 409 })
  })

  it('resolves error for a 500 and for a transport failure', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(500, null))
    await expect(patchTask('t1', { expectedVersion: 1 })).resolves.toEqual({ kind: 'error', status: 500 })
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(patchTask('t1', { expectedVersion: 1 })).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

// ---------------------------------------------------------------------------------------------
// M2 functions, M4 extensions
// ---------------------------------------------------------------------------------------------

describe('createTask — M4 date keys and the 422 allowlist', () => {
  it('sends the date keys that are given and omits the ones that are not', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1', version: 1 }))
    await createTask({
      title: 'x',
      dueDate: '2031-03-15',
      dueTime: '10:00',
      startDate: null,
      timeZone: 'Asia/Shanghai',
      remindAt: null,
    })
    expect(sentBody()).toStrictEqual({
      title: 'x',
      dueDate: '2031-03-15',
      dueTime: '10:00',
      startDate: null,
      timeZone: 'Asia/Shanghai',
      remindAt: null,
    })
  })

  it('sends title only when no date key is given (the M2 request body)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1' }))
    await createTask({ title: 'x' })
    expect(sentBody()).toStrictEqual({ title: 'x' })
  })

  it('resolves ok with version when the 200 body carries one, and without the key when it does not', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1', version: 1 }))
    await expect(createTask({ title: 'x' })).resolves.toStrictEqual({ kind: 'ok', id: 't1', version: 1 })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1' }))
    const bare = await createTask({ title: 'x' })
    expect(bare).toStrictEqual({ kind: 'ok', id: 't1' })
    expect('version' in bare).toBe(false)
  })

  it.each([
    ['0', 0],
    ['fractional', 1.5],
    ['string', '1'],
    ['null', null],
  ])('resolves error for a 200 body whose version is present but not a positive integer: %s', async (_label, version) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1', version }))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it.each([...CREATE_TASK_VALIDATION_CODES])('resolves validation %s for a 422 with that allowlisted code', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'validation', code })
  })

  it('still resolves error (NOT validation) for a 422 code outside the allowlist', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'VALIDATION_FAILED' } }))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'error', status: 422 })
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'INVALID_DESCRIPTION' } }))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'error', status: 422 })
  })

  it('keeps the M2 readings of ORG_MISSING and INVALID_TITLE', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'org_missing' })
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'INVALID_TITLE' } }))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'invalid_title' })
  })
})

describe('getTask — M4 optional keys', () => {
  function withTreeDefaults(body: Record<string, unknown>): Record<string, unknown> {
    return { ...body, parentId: null, depth: 0, children: [] }
  }

  it('an M2-shaped body parses without any of the M4 keys', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, m2TaskBody()))
    const result = await getTask('t1')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    for (const key of ['version', 'description', 'startDate', 'startTime', 'remindAt', 'listIds'] as const) {
      expect(key in result.task).toBe(false)
    }
  })

  it('an M4-shaped body parses with version, the four edit keys and listIds', async () => {
    const body = m2TaskBody(m4TaskKeys)
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'ok', task: withTreeDefaults(body) })
  })

  it('the four edit keys may all be null', async () => {
    const body = m2TaskBody({ description: null, startDate: null, startTime: null, remindAt: null })
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    const result = await getTask('t1')
    expect(result).toEqual({ kind: 'ok', task: withTreeDefaults(body) })
    if (result.kind === 'ok') expect(result.task.description).toBeNull()
  })

  it.each([
    ['version 0', { version: 0 }],
    ['negative version', { version: -1 }],
    ['fractional version', { version: 1.5 }],
    ['string version', { version: '1' }],
    ['null version', { version: null }],
    ['description present without the other three', { description: 'd' }],
    ['startDate present without the other three', { startDate: '2031-03-10' }],
    ['startTime present without the other three', { startTime: '09:00:00' }],
    ['remindAt present without the other three', { remindAt: null }],
    ['three of four present (description missing)', { startDate: null, startTime: null, remindAt: null }],
    ['three of four present (remindAt missing)', { description: null, startDate: null, startTime: null }],
    ['description wrong type', { ...m4TaskKeys, description: 1 }],
    ['startDate wrong type', { ...m4TaskKeys, startDate: 20310310 }],
    ['startTime wrong type', { ...m4TaskKeys, startTime: true }],
    ['remindAt wrong type', { ...m4TaskKeys, remindAt: {} }],
    ['listIds not an array', { listIds: 'tlst_1' }],
    ['listIds with a non-string entry', { listIds: ['tlst_1', 1] }],
    ['listIds with a null entry', { listIds: [null] }],
  ])('resolves error for a malformed 200 body: %s', async (_label, over) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, m2TaskBody(over)))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('an empty listIds array parses as an empty array', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, m2TaskBody({ listIds: [] })))
    const result = await getTask('t1')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.task.listIds).toEqual([])
  })
})

// FE-8: the detail's `canManageMembers` (PR-3a; `[fe-45]` ruled 2026-10-07).
// Optional on the client, like the M3 ability flags: parsed when present, absent from main's M3
// body.
describe('getTask — canManageMembers (FE-8)', () => {
  it.each([true, false])('parses canManageMembers: %s as that boolean, beside canEdit', async (flag) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, m2TaskBody({ ...m4TaskKeys, canEdit: true, canManageMembers: flag })))
    const result = await getTask('t1')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.task.canManageMembers).toBe(flag)
    expect(result.task.canEdit).toBe(true)
  })

  it('a body without the key parses without it (an older backend)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, m2TaskBody({ canEdit: true })))
    const result = await getTask('t1')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect('canManageMembers' in result.task).toBe(false)
  })

  it.each([
    ['a number', 1],
    ['a string', 'true'],
    ['null', null],
    ['an object', {}],
  ])('resolves error when canManageMembers is %s', async (_label, value) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, m2TaskBody({ canManageMembers: value })))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

// FE-8: 422 INACTIVE_ORG_MEMBER at the three task write points PR-3a S9 checks (R17 / N2, ruled
// 2026-10-07): an assignee or a follower added, and an assignee named at creation.
describe('task member writes — 422 INACTIVE_ORG_MEMBER (FE-8)', () => {
  const inactive = () => jsonResponse(422, { error: { code: 'INACTIVE_ORG_MEMBER' } })

  it('addAssignee resolves validation INACTIVE_ORG_MEMBER and sent { userId }', async () => {
    h.apiFetch.mockResolvedValue(inactive())
    await expect(addAssignee('t1', 'u9')).resolves.toEqual({ kind: 'validation', code: 'INACTIVE_ORG_MEMBER' })
    expect(lastCall()[0]).toBe('/api/tasks/t1/assignees')
    expect(lastCall()[1]?.method).toBe('POST')
    expect(sentBody()).toEqual({ userId: 'u9' })
  })

  it('addFollower resolves validation INACTIVE_ORG_MEMBER and sent { userId }', async () => {
    h.apiFetch.mockResolvedValue(inactive())
    await expect(addFollower('t1', 'u9')).resolves.toEqual({ kind: 'validation', code: 'INACTIVE_ORG_MEMBER' })
    expect(lastCall()[0]).toBe('/api/tasks/t1/followers')
    expect(lastCall()[1]?.method).toBe('POST')
    expect(sentBody()).toEqual({ userId: 'u9' })
  })

  it('createTask naming an assignee resolves validation INACTIVE_ORG_MEMBER and sent the assignees', async () => {
    h.apiFetch.mockResolvedValue(inactive())
    await expect(createTask({ title: 'x', assignees: ['u1', 'u9'] })).resolves.toEqual({ kind: 'validation', code: 'INACTIVE_ORG_MEMBER' })
    expect(lastCall()[0]).toBe('/api/tasks')
    expect(sentBody()).toEqual({ title: 'x', assignees: ['u1', 'u9'] })
  })
})

describe('listTasks — page and total', () => {
  it('without a page the request string is the M2 one, byte for byte', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [] }))
    await listTasks('assigned')
    expect(lastCall()[0]).toBe('/api/tasks?view=assigned')
  })

  it('with a page it appends limit (the fixed page size) and the given offset', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], total: 0 }))
    await listTasks('assigned', { offset: 100 })
    expect(lastCall()[0]).toBe(`/api/tasks?view=assigned&limit=${TASK_PAGE_LIMIT}&offset=100`)
    await listTasks('created', { offset: 0 })
    expect(lastCall()[0]).toBe('/api/tasks?view=created&limit=100&offset=0')
  })

  it('carries total when the body has it, and omits the key when the body does not', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [itemBody], total: 5 }))
    await expect(listTasks('assigned')).resolves.toStrictEqual({ kind: 'ok', items: [itemBody], total: 5 })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [itemBody] }))
    const bare = await listTasks('assigned')
    expect(bare).toStrictEqual({ kind: 'ok', items: [itemBody] })
    expect('total' in bare).toBe(false)
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '3'],
    ['null', null],
  ])('resolves error for a 200 body whose total is present but not a non-negative integer: %s', async (_label, total) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], total }))
    await expect(listTasks('assigned')).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

describe('fetchPendingCount — badgeScope', () => {
  it("resolves ok with badgeScope 'off' for an 'off' body with a zero count", async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { count: 0, badgeScope: 'off' }))
    await expect(fetchPendingCount()).resolves.toStrictEqual({ kind: 'ok', count: 0, badgeScope: 'off' })
  })

  it("resolves error for an 'off' body whose count is not zero", async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { count: 3, badgeScope: 'off' }))
    await expect(fetchPendingCount()).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it("resolves error for an 'off' body whose count is not a count", async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { count: 'x', badgeScope: 'off' }))
    await expect(fetchPendingCount()).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it.each([
    ['key absent', { count: 3 }, 3],
    ["'overdue'", { count: 3, badgeScope: 'overdue' }, 3],
    ["'overdue_or_today'", { count: 3, badgeScope: 'overdue_or_today' }, 3],
    ['an unknown value', { count: 3, badgeScope: 'weird' }, 3],
    ["an unknown value with a zero count", { count: 0, badgeScope: 'on' }, 0],
    ['a non-string value', { count: 2, badgeScope: 1 }, 2],
  ])('resolves ok with the count and no badgeScope key when badgeScope is %s', async (_label, body, count) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    const result = await fetchPendingCount()
    expect(result).toStrictEqual({ kind: 'ok', count })
    expect('badgeScope' in result).toBe(false)
  })
})

describe('resolveViewerTimeZone', () => {
  const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions

  afterEach(() => {
    Intl.DateTimeFormat.prototype.resolvedOptions = originalResolvedOptions
  })

  it('returns the zone Intl reports, read fresh on each call', () => {
    Intl.DateTimeFormat.prototype.resolvedOptions = () => ({ timeZone: 'Pacific/Kiritimati' }) as Intl.ResolvedDateTimeFormatOptions
    expect(resolveViewerTimeZone()).toBe('Pacific/Kiritimati')
    Intl.DateTimeFormat.prototype.resolvedOptions = () => ({ timeZone: 'Asia/Tokyo' }) as Intl.ResolvedDateTimeFormatOptions
    expect(resolveViewerTimeZone()).toBe('Asia/Tokyo')
  })

  it("returns '' when the platform reports no zone or throws", () => {
    Intl.DateTimeFormat.prototype.resolvedOptions = () => ({}) as Intl.ResolvedDateTimeFormatOptions
    expect(resolveViewerTimeZone()).toBe('')
    Intl.DateTimeFormat.prototype.resolvedOptions = () => { throw new RangeError('no zone') }
    expect(resolveViewerTimeZone()).toBe('')
  })
})

// ---------------------------------------------------------------------------------------------
// Settings (S3)
// ---------------------------------------------------------------------------------------------

describe('parseTaskSettings', () => {
  it('parses the contract body and ignores keys outside the four', () => {
    expect(parseTaskSettings({ ...settingsBody, extra: 1 })).toStrictEqual(settingsBody)
    expect(parseTaskSettings({
      badgeScope: 'overdue_or_today',
      dailyReminderEnabled: true,
      defaultRemindPolicy: { mode: 'none' },
      timeZone: 'Asia/Shanghai',
    })).toStrictEqual({
      badgeScope: 'overdue_or_today',
      dailyReminderEnabled: true,
      defaultRemindPolicy: { mode: 'none' },
      timeZone: 'Asia/Shanghai',
    })
  })

  it.each([
    ['badgeScope outside the closed set', { badgeScope: 'all_open' }],
    ['badgeScope missing', { badgeScope: undefined }],
    ['badgeScope not a string', { badgeScope: 1 }],
    ['dailyReminderEnabled not a boolean', { dailyReminderEnabled: 'yes' }],
    ['dailyReminderEnabled missing', { dailyReminderEnabled: undefined }],
    ['defaultRemindPolicy null', { defaultRemindPolicy: null }],
    ['defaultRemindPolicy a string', { defaultRemindPolicy: 'default' }],
    ['defaultRemindPolicy mode outside the closed set', { defaultRemindPolicy: { mode: 'weekly' } }],
    ['defaultRemindPolicy without mode', { defaultRemindPolicy: {} }],
    ['timeZone not a string or null', { timeZone: 1 }],
    ['timeZone missing', { timeZone: undefined }],
  ])('returns null for a malformed body: %s', (_label, over) => {
    expect(parseTaskSettings({ ...settingsBody, ...over })).toBeNull()
  })

  it('returns null for a non-object body', () => {
    expect(parseTaskSettings(null)).toBeNull()
    expect(parseTaskSettings('x')).toBeNull()
  })
})

describe('getTaskSettings', () => {
  it('GETs /api/task-settings with no options and resolves ok with the parsed settings', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, settingsBody))
    const result = await getTaskSettings()
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-settings')
    expect(options).toBeUndefined()
    expect(result).toStrictEqual({ kind: 'ok', settings: settingsBody })
  })

  it('resolves not_found for a 404 (a missing route or a missing org — the contract does not distinguish)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND' } }))
    await expect(getTaskSettings()).resolves.toEqual({ kind: 'not_found' })
  })

  it('resolves forbidden for a 403, error for a 500, error for a malformed 200, error on transport failure', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(getTaskSettings()).resolves.toEqual({ kind: 'forbidden' })
    h.apiFetch.mockResolvedValue(jsonResponse(500, null))
    await expect(getTaskSettings()).resolves.toEqual({ kind: 'error', status: 500 })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { ...settingsBody, badgeScope: 'nope' }))
    await expect(getTaskSettings()).resolves.toEqual({ kind: 'error', status: 200 })
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(getTaskSettings()).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

describe('patchTaskSettings', () => {
  it('PATCHes /api/task-settings with only the defined keys (timeZone null is sent, undefined is not)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, settingsBody))
    await patchTaskSettings({ timeZone: null, badgeScope: undefined })
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-settings')
    expect(options?.method).toBe('PATCH')
    expect(sentBody()).toStrictEqual({ timeZone: null })
  })

  it('sends all four keys when all four are given, and resolves ok with the merged settings', async () => {
    const merged = { badgeScope: 'off', dailyReminderEnabled: true, defaultRemindPolicy: { mode: 'none' }, timeZone: 'Asia/Shanghai' }
    h.apiFetch.mockResolvedValue(jsonResponse(200, merged))
    const result = await patchTaskSettings({
      badgeScope: 'off',
      dailyReminderEnabled: true,
      defaultRemindPolicy: { mode: 'none' },
      timeZone: 'asia/shanghai',
    })
    expect(sentBody()).toStrictEqual({
      badgeScope: 'off',
      dailyReminderEnabled: true,
      defaultRemindPolicy: { mode: 'none' },
      timeZone: 'asia/shanghai',
    })
    expect(result).toStrictEqual({ kind: 'ok', settings: merged })
  })

  it.each([
    'INVALID_SETTINGS',
    'INVALID_BADGE_SCOPE',
    'INVALID_DAILY_REMINDER_ENABLED',
    'INVALID_POLICY',
    'INVALID_TIME_ZONE',
    'DAILY_REMINDER_REQUIRES_TIME_ZONE',
  ])('resolves validation %s for a 422 with that code', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(patchTaskSettings({ badgeScope: 'off' })).resolves.toEqual({ kind: 'validation', code })
  })

  it('resolves org_missing / not_found / forbidden / error for 422 ORG_MISSING / 404 / 403 / a malformed 200', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(patchTaskSettings({ badgeScope: 'off' })).resolves.toEqual({ kind: 'org_missing' })
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(patchTaskSettings({ badgeScope: 'off' })).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(patchTaskSettings({ badgeScope: 'off' })).resolves.toEqual({ kind: 'forbidden' })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { ...settingsBody, defaultRemindPolicy: null }))
    await expect(patchTaskSettings({ badgeScope: 'off' })).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

// ---------------------------------------------------------------------------------------------
// Lists (S5)
// ---------------------------------------------------------------------------------------------

describe('parseTaskList', () => {
  it('parses the contract body, with ownerId and archivedAt nullable', () => {
    expect(parseTaskList({ ...listBody, extra: true })).toStrictEqual(listBody)
    expect(parseTaskList({ ...listBody, ownerId: null, archivedAt: ISO, myRole: 'read' })).toStrictEqual({
      ...listBody,
      ownerId: null,
      archivedAt: ISO,
      myRole: 'read',
    })
  })

  it.each([
    ['id missing', { id: undefined }],
    ['name not a string', { name: 1 }],
    ['createdBy missing', { createdBy: undefined }],
    ['ownerId wrong type', { ownerId: 1 }],
    ['archivedAt wrong type', { archivedAt: false }],
    ['createdAt missing', { createdAt: undefined }],
    ['updatedAt wrong type', { updatedAt: 1 }],
    ['myRole outside the closed set', { myRole: 'admin' }],
    ['myRole missing', { myRole: undefined }],
  ])('returns null for a malformed body: %s', (_label, over) => {
    expect(parseTaskList({ ...listBody, ...over })).toBeNull()
  })
})

describe('listTaskLists', () => {
  it('GETs /api/task-lists with includeArchived, the fixed limit and the given offset', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [listBody], total: 1 }))
    const result = await listTaskLists({ includeArchived: false, offset: 0 })
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists?includeArchived=false&limit=100&offset=0')
    expect(options).toBeUndefined()
    expect(result).toStrictEqual({ kind: 'ok', items: [listBody], total: 1 })
    await listTaskLists({ includeArchived: true, offset: 100 })
    expect(lastCall()[0]).toBe('/api/task-lists?includeArchived=true&limit=100&offset=100')
  })

  it('resolves org_missing for the degraded body (no total) and error for another degraded reason', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    await expect(listTaskLists({ includeArchived: false, offset: 0 })).resolves.toEqual({ kind: 'org_missing' })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'predicate_error' }))
    await expect(listTaskLists({ includeArchived: false, offset: 0 })).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves forbidden / not_found / error for 403 / 404 / 422 (a page code is contract drift) / 500', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(listTaskLists({ includeArchived: false, offset: 0 })).resolves.toEqual({ kind: 'forbidden' })
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(listTaskLists({ includeArchived: false, offset: 0 })).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'INVALID_FILTER' } }))
    await expect(listTaskLists({ includeArchived: false, offset: 0 })).resolves.toEqual({ kind: 'error', status: 422 })
    h.apiFetch.mockResolvedValue(jsonResponse(500, null))
    await expect(listTaskLists({ includeArchived: false, offset: 0 })).resolves.toEqual({ kind: 'error', status: 500 })
  })

  it.each([
    ['an item with a role outside the closed set', { items: [{ ...listBody, myRole: 'admin' }], total: 1 }],
    ['items not an array', { items: {}, total: 0 }],
    ['total missing', { items: [] }],
    ['total negative', { items: [], total: -1 }],
    ['total fractional', { items: [], total: 0.5 }],
    ['total a string', { items: [], total: '1' }],
    ['a non-object body', null],
  ])('resolves error for a malformed 200 body: %s', async (_label, body) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(listTaskLists({ includeArchived: false, offset: 0 })).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

describe('listAllTaskLists', () => {
  it('reads every page with the includeArchived filter, advancing the offset by rows read', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: page(listBody, 0, 100), total: 130 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: page(listBody, 100, 30), total: 130 }))
    const result = await listAllTaskLists({ includeArchived: true })
    expect(calledPaths()).toEqual([
      '/api/task-lists?includeArchived=true&limit=100&offset=0',
      '/api/task-lists?includeArchived=true&limit=100&offset=100',
    ])
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.items).toHaveLength(130)
    expect(result.total).toBe(130)
  })

  it('stops once the caller says the read is superseded', async () => {
    h.apiFetch.mockImplementation(async () => jsonResponse(200, { items: page(listBody, 0, 100), total: 1000 }))
    let superseded = false
    const pending = listAllTaskLists({ includeArchived: false }, { isSuperseded: () => superseded })
    superseded = true
    await pending
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
  })
})

describe('createTaskList', () => {
  it('POSTs /api/task-lists with the name and resolves ok with the list', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, listBody))
    const result = await createTaskList('Launch')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists')
    expect(options?.method).toBe('POST')
    expect(sentBody()).toStrictEqual({ name: 'Launch' })
    expect(result).toStrictEqual({ kind: 'ok', list: listBody })
  })

  it.each(['INVALID_NAME', 'NAME_TOO_LONG'])('resolves validation %s for a 422 with that code', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(createTaskList('x')).resolves.toEqual({ kind: 'validation', code })
  })

  it('resolves org_missing / not_found / forbidden / error for 422 ORG_MISSING / 404 / 403 / a malformed 200', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(createTaskList('x')).resolves.toEqual({ kind: 'org_missing' })
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(createTaskList('x')).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(createTaskList('x')).resolves.toEqual({ kind: 'forbidden' })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { ...listBody, myRole: 'none' }))
    await expect(createTaskList('x')).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

describe('getTaskList', () => {
  it('GETs /api/task-lists/:id with no options and resolves ok with the list', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, listBody))
    const result = await getTaskList('tlst_1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1')
    expect(options).toBeUndefined()
    expect(result).toStrictEqual({ kind: 'ok', list: listBody })
  })

  it('resolves not_found for a 404 (missing, another org, not a member — all the same), forbidden for a 403, error otherwise', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND' } }))
    await expect(getTaskList('tlst_1')).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(getTaskList('tlst_1')).resolves.toEqual({ kind: 'forbidden' })
    h.apiFetch.mockResolvedValue(jsonResponse(500, null))
    await expect(getTaskList('tlst_1')).resolves.toEqual({ kind: 'error', status: 500 })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { ...listBody, id: 1 }))
    await expect(getTaskList('tlst_1')).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

describe('renameTaskList / archiveTaskList / unarchiveTaskList', () => {
  it('renameTaskList PATCHes /api/task-lists/:id with the name', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { ...listBody, name: 'Renamed' }))
    const result = await renameTaskList('tlst_1', 'Renamed')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1')
    expect(options?.method).toBe('PATCH')
    expect(sentBody()).toStrictEqual({ name: 'Renamed' })
    expect(result).toStrictEqual({ kind: 'ok', list: { ...listBody, name: 'Renamed' } })
  })

  it.each(['INVALID_NAME', 'NAME_TOO_LONG'])('renameTaskList resolves validation %s', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(renameTaskList('tlst_1', 'x')).resolves.toEqual({ kind: 'validation', code })
  })

  it('renameTaskList resolves not_found for a 404 and org_missing for a 422 ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(renameTaskList('tlst_1', 'x')).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(renameTaskList('tlst_1', 'x')).resolves.toEqual({ kind: 'org_missing' })
  })

  it('archiveTaskList POSTs /api/task-lists/:id/archive with no body and resolves ok with the list', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { ...listBody, archivedAt: ISO }))
    const result = await archiveTaskList('tlst_1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/archive')
    expect(options?.method).toBe('POST')
    expect(options?.body).toBeUndefined()
    expect(result).toStrictEqual({ kind: 'ok', list: { ...listBody, archivedAt: ISO } })
  })

  it('unarchiveTaskList POSTs /api/task-lists/:id/unarchive with no body', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, listBody))
    await expect(unarchiveTaskList('tlst_1')).resolves.toStrictEqual({ kind: 'ok', list: listBody })
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/unarchive')
    expect(options?.method).toBe('POST')
    expect(options?.body).toBeUndefined()
  })

  it('archive / unarchive resolve not_found / org_missing / forbidden / error like every write', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(archiveTaskList('tlst_1')).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(unarchiveTaskList('tlst_1')).resolves.toEqual({ kind: 'org_missing' })
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(archiveTaskList('tlst_1')).resolves.toEqual({ kind: 'forbidden' })
    h.apiFetch.mockResolvedValue(jsonResponse(200, {}))
    await expect(unarchiveTaskList('tlst_1')).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

describe('listTaskListEvents', () => {
  it('GETs /api/task-lists/:id/events with the fixed limit and the given offset', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [eventBody], total: 1 }))
    const result = await listTaskListEvents('tlst_1', { offset: 0 })
    expect(lastCall()[0]).toBe('/api/task-lists/tlst_1/events?limit=100&offset=0')
    expect(result).toStrictEqual({ kind: 'ok', items: [eventBody], total: 1 })
    await listTaskListEvents('tlst_1', { offset: 100 })
    expect(lastCall()[0]).toBe('/api/task-lists/tlst_1/events?limit=100&offset=100')
  })

  it('accepts an eventType outside the known words (it is checked as a string only)', async () => {
    const unknown = { ...eventBody, eventType: 'something_new', payload: { targetUserId: 'u2' } }
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [unknown], total: 1 }))
    await expect(listTaskListEvents('tlst_1', { offset: 0 })).resolves.toStrictEqual({ kind: 'ok', items: [unknown], total: 1 })
  })

  it.each([
    ['eventType not a string', { eventType: 1 }],
    ['payload missing', { payload: undefined }],
    ['occurredAt missing', { occurredAt: undefined }],
    ['listId not a string', { listId: null }],
    ['actorId missing', { actorId: undefined }],
  ])('resolves error for a malformed event row: %s', async (_label, over) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [{ ...eventBody, ...over }], total: 1 }))
    await expect(listTaskListEvents('tlst_1', { offset: 0 })).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves not_found for a 404 and org_missing for a degraded body', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(listTaskListEvents('tlst_1', { offset: 0 })).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    await expect(listTaskListEvents('tlst_1', { offset: 0 })).resolves.toEqual({ kind: 'org_missing' })
  })
})

// ---------------------------------------------------------------------------------------------
// List members (S6)
// ---------------------------------------------------------------------------------------------

describe('listTaskListMembers', () => {
  it('reads /api/task-lists/:id/members page by page and resolves ok with the members', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [memberBody, { ...memberBody, userId: 'u1', role: 'owner' }], total: 2 }))
    const result = await listTaskListMembers('tlst_1')
    expect(calledPaths()).toEqual(['/api/task-lists/tlst_1/members?limit=100&offset=0'])
    expect(result).toStrictEqual({
      kind: 'ok',
      items: [memberBody, { ...memberBody, userId: 'u1', role: 'owner' }],
      total: 2,
    })
  })

  it('reads a second page when the first does not reach total', async () => {
    const members = (from: number, count: number) =>
      Array.from({ length: count }, (_unused, index) => ({ ...memberBody, userId: `u${from + index}` }))
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: members(0, 100), total: 101 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: members(100, 1), total: 101 }))
    const result = await listTaskListMembers('tlst_1')
    expect(calledPaths()).toEqual([
      '/api/task-lists/tlst_1/members?limit=100&offset=0',
      '/api/task-lists/tlst_1/members?limit=100&offset=100',
    ])
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.items).toHaveLength(101)
  })

  it.each([
    ['role outside the closed set', { role: 'admin' }],
    ['userId missing', { userId: undefined }],
    ['createdAt not a string', { createdAt: 1 }],
  ])('resolves error for a malformed member row: %s', async (_label, over) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [{ ...memberBody, ...over }], total: 1 }))
    await expect(listTaskListMembers('tlst_1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves not_found / forbidden / org_missing for 404 / 403 / the degraded body', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(listTaskListMembers('tlst_1')).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(listTaskListMembers('tlst_1')).resolves.toEqual({ kind: 'forbidden' })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    await expect(listTaskListMembers('tlst_1')).resolves.toEqual({ kind: 'org_missing' })
  })
})

describe('member writes', () => {
  const membersOk = { id: 'tlst_1', members: [{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'edit' }] }

  it('addTaskListMember POSTs /api/task-lists/:id/members with userId and role, and resolves ok with the roster', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, membersOk))
    const result = await addTaskListMember('tlst_1', 'u2', 'edit')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/members')
    expect(options?.method).toBe('POST')
    expect(sentBody()).toStrictEqual({ userId: 'u2', role: 'edit' })
    expect(result).toStrictEqual({ kind: 'ok', id: 'tlst_1', members: membersOk.members })
  })

  it.each(['INVALID_MEMBER', 'INVALID_ROLE', 'INACTIVE_ORG_MEMBER', 'LIMIT'])('addTaskListMember resolves validation %s', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(addTaskListMember('tlst_1', 'u2', 'read')).resolves.toEqual({ kind: 'validation', code })
  })

  it('changeTaskListMemberRole PATCHes /api/task-lists/:id/members/:userId (URI-encoded) with the role', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, membersOk))
    const result = await changeTaskListMemberRole('tlst_1', 'u 2', 'read')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/members/u%202')
    expect(options?.method).toBe('PATCH')
    expect(sentBody()).toStrictEqual({ role: 'read' })
    expect(result).toStrictEqual({ kind: 'ok', id: 'tlst_1', members: membersOk.members })
  })

  it.each(['INVALID_MEMBER', 'INVALID_ROLE', 'OWNER_MUST_TRANSFER'])('changeTaskListMemberRole resolves validation %s', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(changeTaskListMemberRole('tlst_1', 'u2', 'read')).resolves.toEqual({ kind: 'validation', code })
  })

  it('removeTaskListMember DELETEs /api/task-lists/:id/members/:userId with no body', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, membersOk))
    const result = await removeTaskListMember('tlst_1', 'u2')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/members/u2')
    expect(options?.method).toBe('DELETE')
    expect(options?.body).toBeUndefined()
    expect(result).toStrictEqual({ kind: 'ok', id: 'tlst_1', members: membersOk.members })
  })

  it.each(['INVALID_MEMBER', 'CREATED_BY_IMMUTABLE', 'OWNER_MUST_TRANSFER'])('removeTaskListMember resolves validation %s', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(removeTaskListMember('tlst_1', 'u2')).resolves.toEqual({ kind: 'validation', code })
  })

  it('transferTaskListOwner POSTs /api/task-lists/:id/transfer-owner with the userId', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, membersOk))
    const result = await transferTaskListOwner('tlst_1', 'u2')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/transfer-owner')
    expect(options?.method).toBe('POST')
    expect(sentBody()).toStrictEqual({ userId: 'u2' })
    expect(result).toStrictEqual({ kind: 'ok', id: 'tlst_1', members: membersOk.members })
  })

  it.each(['INVALID_MEMBER', 'TARGET_NOT_MEMBER', 'INACTIVE_ORG_MEMBER'])('transferTaskListOwner resolves validation %s', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(transferTaskListOwner('tlst_1', 'u2')).resolves.toEqual({ kind: 'validation', code })
  })

  it('every member write resolves not_found for a 404 and org_missing for a 422 ORG_MISSING', async () => {
    for (const call of [
      () => addTaskListMember('tlst_1', 'u2', 'edit'),
      () => changeTaskListMemberRole('tlst_1', 'u2', 'edit'),
      () => removeTaskListMember('tlst_1', 'u2'),
      () => transferTaskListOwner('tlst_1', 'u2'),
    ]) {
      h.apiFetch.mockResolvedValue(jsonResponse(404, null))
      await expect(call()).resolves.toEqual({ kind: 'not_found' })
      h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
      await expect(call()).resolves.toEqual({ kind: 'org_missing' })
    }
  })

  it.each([
    ['id missing', { members: membersOk.members }],
    ['members not an array', { id: 'tlst_1', members: {} }],
    ['a member with a role outside the closed set', { id: 'tlst_1', members: [{ userId: 'u1', role: 'admin' }] }],
    ['a member without userId', { id: 'tlst_1', members: [{ role: 'read' }] }],
  ])('resolves error for a malformed 200 roster: %s', async (_label, body) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(addTaskListMember('tlst_1', 'u2', 'edit')).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

// ---------------------------------------------------------------------------------------------
// List items (S7)
// ---------------------------------------------------------------------------------------------

describe('listTaskListItems', () => {
  it('reads /api/task-lists/:id/items and resolves ok with the six-column rows', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [itemBody], total: 1 }))
    const result = await listTaskListItems('tlst_1')
    expect(calledPaths()).toEqual(['/api/task-lists/tlst_1/items?limit=100&offset=0'])
    expect(result).toStrictEqual({ kind: 'ok', items: [itemBody], total: 1 })
  })

  it.each([
    ['status outside the closed set', { status: 'closed' }],
    ['completion_mode outside the closed set', { completion_mode: 'some' }],
    ['due_at wrong type', { due_at: 1 }],
    ['created_by missing', { created_by: undefined }],
    ['title not a string', { title: 1 }],
    ['id missing', { id: undefined }],
  ])('resolves error for a malformed row: %s', async (_label, over) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [{ ...itemBody, ...over }], total: 1 }))
    await expect(listTaskListItems('tlst_1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves not_found / forbidden / org_missing for 404 / 403 / the degraded body', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(listTaskListItems('tlst_1')).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(listTaskListItems('tlst_1')).resolves.toEqual({ kind: 'forbidden' })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    await expect(listTaskListItems('tlst_1')).resolves.toEqual({ kind: 'org_missing' })
  })
})

describe('addTaskToList / removeTaskFromList', () => {
  it('addTaskToList POSTs /api/task-lists/:id/items with the taskId and resolves ok with listId and taskId', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { listId: 'tlst_1', taskId: 'tsk_1' }))
    const result = await addTaskToList('tlst_1', 'tsk_1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/items')
    expect(options?.method).toBe('POST')
    expect(sentBody()).toStrictEqual({ taskId: 'tsk_1' })
    expect(result).toStrictEqual({ kind: 'ok', listId: 'tlst_1', taskId: 'tsk_1' })
  })

  it.each(['INVALID_TASK', 'LIMIT'])('addTaskToList resolves validation %s', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(addTaskToList('tlst_1', 'tsk_1')).resolves.toEqual({ kind: 'validation', code })
  })

  it('addTaskToList resolves not_found for a 404 (the three conditions fold into it) and org_missing for ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(addTaskToList('tlst_1', 'tsk_1')).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(addTaskToList('tlst_1', 'tsk_1')).resolves.toEqual({ kind: 'org_missing' })
  })

  it('removeTaskFromList DELETEs /api/task-lists/:id/items/:taskId with no body', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { listId: 'tlst_1', taskId: 'tsk_1' }))
    const result = await removeTaskFromList('tlst_1', 'tsk_1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/items/tsk_1')
    expect(options?.method).toBe('DELETE')
    expect(options?.body).toBeUndefined()
    expect(result).toStrictEqual({ kind: 'ok', listId: 'tlst_1', taskId: 'tsk_1' })
  })

  it.each([
    ['listId missing', { taskId: 'tsk_1' }],
    ['taskId not a string', { listId: 'tlst_1', taskId: 1 }],
    ['non-object', null],
  ])('resolves error for a malformed 200 body: %s', async (_label, body) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(addTaskToList('tlst_1', 'tsk_1')).resolves.toEqual({ kind: 'error', status: 200 })
    await expect(removeTaskFromList('tlst_1', 'tsk_1')).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

// ---------------------------------------------------------------------------------------------
// Groups (S8)
// ---------------------------------------------------------------------------------------------

describe('parseTaskGroup', () => {
  it('parses a list-scope group and a personal-scope group', () => {
    expect(parseTaskGroup({ ...listGroupBody, extra: 1 }, 'list')).toStrictEqual(listGroupBody)
    expect(parseTaskGroup({ ...userGroupBody, id: 'tgrp_9', isDefault: false, position: 2 }, 'user')).toStrictEqual({
      ...userGroupBody,
      id: 'tgrp_9',
      isDefault: false,
      position: 2,
    })
  })

  it("accepts id null only in the 'user' scope, and only for the default group", () => {
    expect(parseTaskGroup(userGroupBody, 'user')).toStrictEqual(userGroupBody)
    expect(parseTaskGroup({ ...listGroupBody, id: null }, 'list')).toBeNull()
    expect(parseTaskGroup({ ...userGroupBody, isDefault: false }, 'user')).toBeNull()
  })

  it('rejects a body whose scope is not the expected one', () => {
    expect(parseTaskGroup(listGroupBody, 'user')).toBeNull()
    expect(parseTaskGroup({ ...userGroupBody, id: 'tgrp_1' }, 'list')).toBeNull()
  })

  it.each([
    ['position negative', { position: -1 }],
    ['position fractional', { position: 0.5 }],
    ['position a string', { position: '0' }],
    ['isDefault not a boolean', { isDefault: 'yes' }],
    ['name missing', { name: undefined }],
    ['id a number', { id: 1 }],
    ['scope missing', { scope: undefined }],
  ])('returns null for a malformed body: %s', (_label, over) => {
    expect(parseTaskGroup({ ...listGroupBody, ...over }, 'list')).toBeNull()
  })
})

describe('list-scope groups', () => {
  it('listTaskListGroups GETs /api/task-lists/:id/groups as one page', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [listGroupBody], total: 1 }))
    const result = await listTaskListGroups('tlst_1')
    expect(calledPaths()).toEqual(['/api/task-lists/tlst_1/groups?limit=100&offset=0'])
    expect(result).toStrictEqual({ kind: 'ok', items: [listGroupBody], total: 1 })
  })

  it('listTaskListGroups resolves error for a list-scope group with id null, and not_found / org_missing for 404 / degraded', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [{ ...listGroupBody, id: null }], total: 1 }))
    await expect(listTaskListGroups('tlst_1')).resolves.toEqual({ kind: 'error', status: 200 })
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(listTaskListGroups('tlst_1')).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    await expect(listTaskListGroups('tlst_1')).resolves.toEqual({ kind: 'org_missing' })
  })

  it('createTaskListGroup POSTs /api/task-lists/:id/groups with the name and resolves ok with the group', async () => {
    const created = { ...listGroupBody, id: 'tgrp_2', name: 'Later', position: 1, isDefault: false }
    h.apiFetch.mockResolvedValue(jsonResponse(200, created))
    const result = await createTaskListGroup('tlst_1', 'Later')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/groups')
    expect(options?.method).toBe('POST')
    expect(sentBody()).toStrictEqual({ name: 'Later' })
    expect(result).toStrictEqual({ kind: 'ok', group: created })
  })

  it.each(['INVALID_NAME', 'NAME_TOO_LONG', 'LIMIT'])('createTaskListGroup resolves validation %s', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(createTaskListGroup('tlst_1', 'x')).resolves.toEqual({ kind: 'validation', code })
  })

  it("createTaskListGroup resolves error for a 200 body in the 'user' scope", async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { ...listGroupBody, scope: 'user' }))
    await expect(createTaskListGroup('tlst_1', 'x')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('renameTaskListGroup PATCHes /api/task-lists/:id/groups/:groupId with the name', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { ...listGroupBody, name: 'Done' }))
    const result = await renameTaskListGroup('tlst_1', 'tgrp_1', 'Done')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/groups/tgrp_1')
    expect(options?.method).toBe('PATCH')
    expect(sentBody()).toStrictEqual({ name: 'Done' })
    expect(result).toStrictEqual({ kind: 'ok', group: { ...listGroupBody, name: 'Done' } })
  })

  it.each(['INVALID_NAME', 'NAME_TOO_LONG'])('renameTaskListGroup resolves validation %s', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(renameTaskListGroup('tlst_1', 'tgrp_1', 'x')).resolves.toEqual({ kind: 'validation', code })
  })

  it('deleteTaskListGroup DELETEs /api/task-lists/:id/groups/:groupId with no body and resolves ok with reassignedTo', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 'tgrp_2', deleted: true, reassignedTo: 'tgrp_1' }))
    const result = await deleteTaskListGroup('tlst_1', 'tgrp_2')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/groups/tgrp_2')
    expect(options?.method).toBe('DELETE')
    expect(options?.body).toBeUndefined()
    expect(result).toStrictEqual({ kind: 'ok', id: 'tgrp_2', deleted: true, reassignedTo: 'tgrp_1' })
  })

  it('deleteTaskListGroup resolves validation IS_DEFAULT, and error for a body without deleted: true or reassignedTo', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'IS_DEFAULT' } }))
    await expect(deleteTaskListGroup('tlst_1', 'tgrp_1')).resolves.toEqual({ kind: 'validation', code: 'IS_DEFAULT' })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 'tgrp_2', deleted: false, reassignedTo: 'tgrp_1' }))
    await expect(deleteTaskListGroup('tlst_1', 'tgrp_2')).resolves.toEqual({ kind: 'error', status: 200 })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 'tgrp_2', deleted: true }))
    await expect(deleteTaskListGroup('tlst_1', 'tgrp_2')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('listTaskListGroupItems reads /api/task-lists/:id/group-items page by page and resolves ok with the placements', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [placementBody], total: 1 }))
    const result = await listTaskListGroupItems('tlst_1')
    expect(calledPaths()).toEqual(['/api/task-lists/tlst_1/group-items?limit=100&offset=0'])
    expect(result).toStrictEqual({ kind: 'ok', items: [placementBody], total: 1 })
  })

  it.each([
    ['position negative', { position: -1 }],
    ['position fractional', { position: 1.5 }],
    ['groupId missing', { groupId: undefined }],
    ['taskId not a string', { taskId: 1 }],
  ])('listTaskListGroupItems resolves error for a malformed placement: %s', async (_label, over) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [{ ...placementBody, ...over }], total: 1 }))
    await expect(listTaskListGroupItems('tlst_1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('placeTaskInListGroup PUTs /api/task-lists/:id/group-items/:taskId with groupId (null for the default group) and position', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { taskId: 'tsk_1', groupId: 'tgrp_1', position: 2 }))
    const result = await placeTaskInListGroup('tlst_1', 'tsk_1', null, 2)
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-lists/tlst_1/group-items/tsk_1')
    expect(options?.method).toBe('PUT')
    expect(sentBody()).toStrictEqual({ groupId: null, position: 2 })
    expect(result).toStrictEqual({ kind: 'ok', taskId: 'tsk_1', groupId: 'tgrp_1', position: 2 })
    await placeTaskInListGroup('tlst_1', 'tsk_1', 'tgrp_2', 0)
    expect(sentBody()).toStrictEqual({ groupId: 'tgrp_2', position: 0 })
  })

  it.each(['INVALID_GROUP', 'INVALID_POSITION'])('placeTaskInListGroup resolves validation %s', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(placeTaskInListGroup('tlst_1', 'tsk_1', null, 0)).resolves.toEqual({ kind: 'validation', code })
  })

  it('placeTaskInListGroup resolves error for a 200 body whose groupId is null or whose position is not an index', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { taskId: 'tsk_1', groupId: null, position: 0 }))
    await expect(placeTaskInListGroup('tlst_1', 'tsk_1', null, 0)).resolves.toEqual({ kind: 'error', status: 200 })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { taskId: 'tsk_1', groupId: 'tgrp_1', position: -1 }))
    await expect(placeTaskInListGroup('tlst_1', 'tsk_1', null, 0)).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

describe('personal-scope groups', () => {
  it('listUserGroups GETs /api/task-groups as one page and accepts the synthesized default group (id null)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [userGroupBody], total: 1 }))
    const result = await listUserGroups()
    expect(calledPaths()).toEqual(['/api/task-groups?limit=100&offset=0'])
    expect(result).toStrictEqual({ kind: 'ok', items: [userGroupBody], total: 1 })
  })

  it('listUserGroups resolves org_missing / forbidden / not_found / error for the degraded body / 403 / 404 / 422', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    await expect(listUserGroups()).resolves.toEqual({ kind: 'org_missing' })
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(listUserGroups()).resolves.toEqual({ kind: 'forbidden' })
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(listUserGroups()).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'INVALID_LIMIT' } }))
    await expect(listUserGroups()).resolves.toEqual({ kind: 'error', status: 422 })
  })

  it('createUserGroup POSTs /api/task-groups with the name and resolves ok with the group', async () => {
    const created = { id: 'tgrp_5', scope: 'user', name: 'Week', position: 1, isDefault: false }
    h.apiFetch.mockResolvedValue(jsonResponse(200, created))
    const result = await createUserGroup('Week')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-groups')
    expect(options?.method).toBe('POST')
    expect(sentBody()).toStrictEqual({ name: 'Week' })
    expect(result).toStrictEqual({ kind: 'ok', group: created })
  })

  it.each(['INVALID_NAME', 'NAME_TOO_LONG', 'LIMIT'])('createUserGroup resolves validation %s', async (code) => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
    await expect(createUserGroup('x')).resolves.toEqual({ kind: 'validation', code })
  })

  it('renameUserGroup PATCHes /api/task-groups/:groupId with the name', async () => {
    const renamed = { id: 'tgrp_5', scope: 'user', name: 'Month', position: 1, isDefault: false }
    h.apiFetch.mockResolvedValue(jsonResponse(200, renamed))
    const result = await renameUserGroup('tgrp_5', 'Month')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-groups/tgrp_5')
    expect(options?.method).toBe('PATCH')
    expect(sentBody()).toStrictEqual({ name: 'Month' })
    expect(result).toStrictEqual({ kind: 'ok', group: renamed })
  })

  it('deleteUserGroup DELETEs /api/task-groups/:groupId with no body and resolves ok with reassignedTo', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 'tgrp_5', deleted: true, reassignedTo: 'tgrp_4' }))
    const result = await deleteUserGroup('tgrp_5')
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-groups/tgrp_5')
    expect(options?.method).toBe('DELETE')
    expect(options?.body).toBeUndefined()
    expect(result).toStrictEqual({ kind: 'ok', id: 'tgrp_5', deleted: true, reassignedTo: 'tgrp_4' })
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'IS_DEFAULT' } }))
    await expect(deleteUserGroup('tgrp_4')).resolves.toEqual({ kind: 'validation', code: 'IS_DEFAULT' })
  })

  it('listUserGroupItems reads /api/task-groups/items page by page', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [placementBody], total: 1 }))
    const result = await listUserGroupItems()
    expect(calledPaths()).toEqual(['/api/task-groups/items?limit=100&offset=0'])
    expect(result).toStrictEqual({ kind: 'ok', items: [placementBody], total: 1 })
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    await expect(listUserGroupItems()).resolves.toEqual({ kind: 'org_missing' })
  })

  it('placeTaskInUserGroup PUTs /api/task-groups/items/:taskId with groupId null and position; the 200 body carries the real group id', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { taskId: 'tsk_1', groupId: 'tgrp_4', position: 0 }))
    const result = await placeTaskInUserGroup('tsk_1', null, 0)
    const [path, options] = lastCall()
    expect(path).toBe('/api/task-groups/items/tsk_1')
    expect(options?.method).toBe('PUT')
    expect(sentBody()).toStrictEqual({ groupId: null, position: 0 })
    expect(result).toStrictEqual({ kind: 'ok', taskId: 'tsk_1', groupId: 'tgrp_4', position: 0 })
  })

  it('placeTaskInUserGroup resolves not_found for a 404, org_missing for ORG_MISSING, and the two validation codes', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(placeTaskInUserGroup('tsk_1', null, 0)).resolves.toEqual({ kind: 'not_found' })
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(placeTaskInUserGroup('tsk_1', null, 0)).resolves.toEqual({ kind: 'org_missing' })
    for (const code of ['INVALID_GROUP', 'INVALID_POSITION']) {
      h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code } }))
      await expect(placeTaskInUserGroup('tsk_1', 'tgrp_5', 1)).resolves.toEqual({ kind: 'validation', code })
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The shared paging loop, through listTaskListItems
// ---------------------------------------------------------------------------------------------

describe('collectPages (through listTaskListItems)', () => {
  const items = (from: number, count: number) => page(itemBody, from, count)
  const P = '/api/task-lists/tlst_1/items?limit=100&offset='

  it('reads every page: 250 rows take three requests at offsets 0, 100, 200, in server order', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: items(0, 100), total: 250 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: items(100, 100), total: 250 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: items(200, 50), total: 250 }))
    const result = await listTaskListItems('tlst_1')
    expect(calledPaths()).toEqual([`${P}0`, `${P}100`, `${P}200`])
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.total).toBe(250)
    expect(result.items.map((item) => item.id)).toEqual(items(0, 250).map((item) => item.id))
  })

  it('a short page before total advances the offset by rows read, not by page index', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: items(0, 60), total: 130 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: items(60, 70), total: 130 }))
    const result = await listTaskListItems('tlst_1')
    expect(calledPaths()).toEqual([`${P}0`, `${P}60`])
    expect(result).toMatchObject({ kind: 'ok', total: 130 })
    if (result.kind === 'ok') expect(result.items).toHaveLength(130)
  })

  it('a row that arrives on two pages is kept once, by id', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: items(0, 100), total: 101 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: items(99, 1), total: 101 }))
    const result = await listTaskListItems('tlst_1')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.items).toHaveLength(100)
    expect(new Set(result.items.map((item) => item.id)).size).toBe(100)
    expect(result.total).toBe(101)
  })

  it('exactly one full page is one request (no empty trailing page)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: items(0, 100), total: 100 }))
    const result = await listTaskListItems('tlst_1')
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ kind: 'ok', total: 100 })
  })

  it('an empty page before total is reached stops the loop and the result reports the shortfall', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: items(0, 100), total: 150 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [], total: 150 }))
    const result = await listTaskListItems('tlst_1')
    expect(h.apiFetch).toHaveBeenCalledTimes(2)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.items).toHaveLength(100)
    expect(result.total).toBe(150)
  })

  it('stops at TASK_MAX_PAGES and reports items.length < total', async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      const offset = Number(new URL(`http://x${path}`).searchParams.get('offset'))
      return jsonResponse(200, { items: items(offset, 100), total: 10000 })
    })
    const result = await listTaskListItems('tlst_1')
    expect(h.apiFetch).toHaveBeenCalledTimes(TASK_MAX_PAGES)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.items).toHaveLength(TASK_PAGE_LIMIT * TASK_MAX_PAGES)
    expect(result.items.length).toBeLessThan(result.total)
  })

  it('stops requesting further pages once the caller says the read is superseded', async () => {
    h.apiFetch.mockImplementation(async () => jsonResponse(200, { items: items(0, 100), total: 1000 }))
    let superseded = false
    const pending = listTaskListItems('tlst_1', { isSuperseded: () => superseded })
    superseded = true
    await pending
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
  })

  it('a later page failing fails the whole read', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: items(0, 100), total: 150 }))
      .mockResolvedValueOnce(jsonResponse(500, null))
    await expect(listTaskListItems('tlst_1')).resolves.toEqual({ kind: 'error', status: 500 })
  })

  it('a degraded body on a later page resolves org_missing for the whole read', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: items(0, 100), total: 150 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    await expect(listTaskListItems('tlst_1')).resolves.toEqual({ kind: 'org_missing' })
  })
})

// ---------------------------------------------------------------------------------------------
// Path segments: refused ids make no request; accepted ids are URI-encoded.
// ---------------------------------------------------------------------------------------------

const NOT_FOUND = { kind: 'not_found' }
const INVALID_MEMBER = { kind: 'validation', code: 'INVALID_MEMBER' }

describe('an empty, "." or ".." id in any path position is refused before any request', () => {
  const cases: Array<[string, (bad: string) => Promise<unknown>, unknown]> = [
    ['patchTask id', (bad) => patchTask(bad, { expectedVersion: 1 }), NOT_FOUND],
    ['getTaskList id', (bad) => getTaskList(bad), NOT_FOUND],
    ['renameTaskList id', (bad) => renameTaskList(bad, 'x'), NOT_FOUND],
    ['archiveTaskList id', (bad) => archiveTaskList(bad), NOT_FOUND],
    ['unarchiveTaskList id', (bad) => unarchiveTaskList(bad), NOT_FOUND],
    ['listTaskListEvents id', (bad) => listTaskListEvents(bad, { offset: 0 }), NOT_FOUND],
    ['listTaskListMembers id', (bad) => listTaskListMembers(bad), NOT_FOUND],
    ['addTaskListMember id', (bad) => addTaskListMember(bad, 'u1', 'read'), NOT_FOUND],
    ['addTaskListMember userId', (bad) => addTaskListMember('tlst_1', bad, 'read'), INVALID_MEMBER],
    ['changeTaskListMemberRole id', (bad) => changeTaskListMemberRole(bad, 'u1', 'read'), NOT_FOUND],
    ['changeTaskListMemberRole userId', (bad) => changeTaskListMemberRole('tlst_1', bad, 'read'), INVALID_MEMBER],
    ['removeTaskListMember id', (bad) => removeTaskListMember(bad, 'u1'), NOT_FOUND],
    ['removeTaskListMember userId', (bad) => removeTaskListMember('tlst_1', bad), INVALID_MEMBER],
    ['transferTaskListOwner id', (bad) => transferTaskListOwner(bad, 'u1'), NOT_FOUND],
    ['transferTaskListOwner userId', (bad) => transferTaskListOwner('tlst_1', bad), INVALID_MEMBER],
    ['listTaskListItems id', (bad) => listTaskListItems(bad), NOT_FOUND],
    ['addTaskToList id', (bad) => addTaskToList(bad, 'tsk_1'), NOT_FOUND],
    ['removeTaskFromList id', (bad) => removeTaskFromList(bad, 'tsk_1'), NOT_FOUND],
    ['removeTaskFromList taskId', (bad) => removeTaskFromList('tlst_1', bad), NOT_FOUND],
    ['listTaskListGroups id', (bad) => listTaskListGroups(bad), NOT_FOUND],
    ['createTaskListGroup id', (bad) => createTaskListGroup(bad, 'x'), NOT_FOUND],
    ['renameTaskListGroup id', (bad) => renameTaskListGroup(bad, 'tgrp_1', 'x'), NOT_FOUND],
    ['renameTaskListGroup groupId', (bad) => renameTaskListGroup('tlst_1', bad, 'x'), NOT_FOUND],
    ['deleteTaskListGroup id', (bad) => deleteTaskListGroup(bad, 'tgrp_1'), NOT_FOUND],
    ['deleteTaskListGroup groupId', (bad) => deleteTaskListGroup('tlst_1', bad), NOT_FOUND],
    ['listTaskListGroupItems id', (bad) => listTaskListGroupItems(bad), NOT_FOUND],
    ['placeTaskInListGroup id', (bad) => placeTaskInListGroup(bad, 'tsk_1', null, 0), NOT_FOUND],
    ['placeTaskInListGroup taskId', (bad) => placeTaskInListGroup('tlst_1', bad, null, 0), NOT_FOUND],
    ['renameUserGroup groupId', (bad) => renameUserGroup(bad, 'x'), NOT_FOUND],
    ['deleteUserGroup groupId', (bad) => deleteUserGroup(bad), NOT_FOUND],
    ['placeTaskInUserGroup taskId', (bad) => placeTaskInUserGroup(bad, null, 0), NOT_FOUND],
  ]

  it.each(cases.flatMap(([label, call, expected]) =>
    ['', '.', '..'].map((bad) => [`${label} = ${JSON.stringify(bad)}`, () => call(bad), expected] as const),
  ))('%s', async (_label, call, expected) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, {}))
    await expect(call()).resolves.toEqual(expected)
    expect(h.apiFetch).not.toHaveBeenCalled()
  })
})

describe('every id position is URI-encoded', () => {
  const R = 'a/b?c#d'
  const E = 'a%2Fb%3Fc%23d'
  it.each([
    ['patchTask id', () => patchTask(R, { expectedVersion: 1 }), `/api/tasks/${E}`],
    ['getTaskList id', () => getTaskList(R), `/api/task-lists/${E}`],
    ['renameTaskList id', () => renameTaskList(R, 'x'), `/api/task-lists/${E}`],
    ['archiveTaskList id', () => archiveTaskList(R), `/api/task-lists/${E}/archive`],
    ['unarchiveTaskList id', () => unarchiveTaskList(R), `/api/task-lists/${E}/unarchive`],
    ['listTaskListEvents id', () => listTaskListEvents(R, { offset: 0 }), `/api/task-lists/${E}/events?limit=100&offset=0`],
    ['listTaskListMembers id', () => listTaskListMembers(R), `/api/task-lists/${E}/members?limit=100&offset=0`],
    ['addTaskListMember id', () => addTaskListMember(R, 'u1', 'read'), `/api/task-lists/${E}/members`],
    ['changeTaskListMemberRole id', () => changeTaskListMemberRole(R, 'u1', 'read'), `/api/task-lists/${E}/members/u1`],
    ['changeTaskListMemberRole userId', () => changeTaskListMemberRole('tlst_1', R, 'read'), `/api/task-lists/tlst_1/members/${E}`],
    ['removeTaskListMember id', () => removeTaskListMember(R, 'u1'), `/api/task-lists/${E}/members/u1`],
    ['removeTaskListMember userId', () => removeTaskListMember('tlst_1', R), `/api/task-lists/tlst_1/members/${E}`],
    ['transferTaskListOwner id', () => transferTaskListOwner(R, 'u1'), `/api/task-lists/${E}/transfer-owner`],
    ['listTaskListItems id', () => listTaskListItems(R), `/api/task-lists/${E}/items?limit=100&offset=0`],
    ['addTaskToList id', () => addTaskToList(R, 'tsk_1'), `/api/task-lists/${E}/items`],
    ['removeTaskFromList id', () => removeTaskFromList(R, 'tsk_1'), `/api/task-lists/${E}/items/tsk_1`],
    ['removeTaskFromList taskId', () => removeTaskFromList('tlst_1', R), `/api/task-lists/tlst_1/items/${E}`],
    ['listTaskListGroups id', () => listTaskListGroups(R), `/api/task-lists/${E}/groups?limit=100&offset=0`],
    ['createTaskListGroup id', () => createTaskListGroup(R, 'x'), `/api/task-lists/${E}/groups`],
    ['renameTaskListGroup id', () => renameTaskListGroup(R, 'tgrp_1', 'x'), `/api/task-lists/${E}/groups/tgrp_1`],
    ['renameTaskListGroup groupId', () => renameTaskListGroup('tlst_1', R, 'x'), `/api/task-lists/tlst_1/groups/${E}`],
    ['deleteTaskListGroup id', () => deleteTaskListGroup(R, 'tgrp_1'), `/api/task-lists/${E}/groups/tgrp_1`],
    ['deleteTaskListGroup groupId', () => deleteTaskListGroup('tlst_1', R), `/api/task-lists/tlst_1/groups/${E}`],
    ['listTaskListGroupItems id', () => listTaskListGroupItems(R), `/api/task-lists/${E}/group-items?limit=100&offset=0`],
    ['placeTaskInListGroup id', () => placeTaskInListGroup(R, 'tsk_1', null, 0), `/api/task-lists/${E}/group-items/tsk_1`],
    ['placeTaskInListGroup taskId', () => placeTaskInListGroup('tlst_1', R, null, 0), `/api/task-lists/tlst_1/group-items/${E}`],
    ['renameUserGroup groupId', () => renameUserGroup(R, 'x'), `/api/task-groups/${E}`],
    ['deleteUserGroup groupId', () => deleteUserGroup(R), `/api/task-groups/${E}`],
    ['placeTaskInUserGroup taskId', () => placeTaskInUserGroup(R, null, 0), `/api/task-groups/items/${E}`],
  ] as const)('%s', async (_label, call, path) => {
    h.apiFetch.mockResolvedValue(jsonResponse(500, {}))
    await call()
    expect(lastCall()[0]).toBe(path)
  })
})

describe('a transport failure resolves error with status 0 in every M4 function', () => {
  it.each([
    ['patchTask', () => patchTask('t1', { expectedVersion: 1 })],
    ['getTaskSettings', () => getTaskSettings()],
    ['patchTaskSettings', () => patchTaskSettings({ badgeScope: 'off' })],
    ['listTaskLists', () => listTaskLists({ includeArchived: false, offset: 0 })],
    ['listAllTaskLists', () => listAllTaskLists({ includeArchived: false })],
    ['createTaskList', () => createTaskList('x')],
    ['getTaskList', () => getTaskList('tlst_1')],
    ['renameTaskList', () => renameTaskList('tlst_1', 'x')],
    ['archiveTaskList', () => archiveTaskList('tlst_1')],
    ['unarchiveTaskList', () => unarchiveTaskList('tlst_1')],
    ['listTaskListEvents', () => listTaskListEvents('tlst_1', { offset: 0 })],
    ['listTaskListMembers', () => listTaskListMembers('tlst_1')],
    ['addTaskListMember', () => addTaskListMember('tlst_1', 'u1', 'read')],
    ['changeTaskListMemberRole', () => changeTaskListMemberRole('tlst_1', 'u1', 'read')],
    ['removeTaskListMember', () => removeTaskListMember('tlst_1', 'u1')],
    ['transferTaskListOwner', () => transferTaskListOwner('tlst_1', 'u1')],
    ['listTaskListItems', () => listTaskListItems('tlst_1')],
    ['addTaskToList', () => addTaskToList('tlst_1', 'tsk_1')],
    ['removeTaskFromList', () => removeTaskFromList('tlst_1', 'tsk_1')],
    ['listTaskListGroups', () => listTaskListGroups('tlst_1')],
    ['createTaskListGroup', () => createTaskListGroup('tlst_1', 'x')],
    ['renameTaskListGroup', () => renameTaskListGroup('tlst_1', 'tgrp_1', 'x')],
    ['deleteTaskListGroup', () => deleteTaskListGroup('tlst_1', 'tgrp_1')],
    ['listTaskListGroupItems', () => listTaskListGroupItems('tlst_1')],
    ['placeTaskInListGroup', () => placeTaskInListGroup('tlst_1', 'tsk_1', null, 0)],
    ['listUserGroups', () => listUserGroups()],
    ['createUserGroup', () => createUserGroup('x')],
    ['renameUserGroup', () => renameUserGroup('tgrp_1', 'x')],
    ['deleteUserGroup', () => deleteUserGroup('tgrp_1')],
    ['listUserGroupItems', () => listUserGroupItems()],
    ['placeTaskInUserGroup', () => placeTaskInUserGroup('tsk_1', null, 0)],
  ] as const)('%s', async (_label, call) => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(call()).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

// ---------------------------------------------------------------------------------------------
// tasksDraft.ts — the pure pre-checks (design §3.3)
// ---------------------------------------------------------------------------------------------

/** A detail in the server's shape: `dueTime` with seconds, a `null` description, a canonical zone. */
const serverTask: TaskDraftSource = {
  title: 'Plan',
  description: null,
  dueDate: '2031-03-15',
  dueTime: '10:00:00',
  startDate: null,
  startTime: null,
  timeZone: 'Asia/Shanghai',
  remindAt: '2031-03-15T01:30:00.000Z',
}

function draftOf(over: Partial<TaskDraft> = {}): TaskDraft {
  return { ...initDraft(serverTask), ...over }
}

describe('initDraft / createEditorState', () => {
  it('normalizes the server shape: seconds dropped from times, null description and zone as empty strings, remindTouched false', () => {
    expect(initDraft(serverTask)).toStrictEqual({
      title: 'Plan',
      description: '',
      dueDate: '2031-03-15',
      dueTime: '10:00',
      startDate: null,
      startTime: null,
      timeZone: 'Asia/Shanghai',
      remindAt: '2031-03-15T01:30:00.000Z',
      remindTouched: false,
    })
  })

  it('reads the optional keys of an older detail body as their empty values', () => {
    const older = { title: 'T', dueDate: null, dueTime: null, timeZone: null } as TaskDetail
    expect(initDraft(older)).toStrictEqual({
      title: 'T',
      description: '',
      dueDate: null,
      dueTime: null,
      startDate: null,
      startTime: null,
      timeZone: '',
      remindAt: null,
      remindTouched: false,
    })
  })

  it('keeps a start time in the minutes form and a description as given', () => {
    const draft = initDraft({ ...serverTask, description: 'd', startDate: '2031-03-10', startTime: '09:30:00' })
    expect(draft.description).toBe('d')
    expect(draft.startDate).toBe('2031-03-10')
    expect(draft.startTime).toBe('09:30')
  })

  it('createEditorState starts idle with no draft, no errors and no conflict', () => {
    expect(createEditorState()).toStrictEqual({
      draft: null,
      dirty: false,
      phase: 'idle',
      conflictVersion: null,
      fieldErrors: {},
      serverUpdated: false,
    })
  })
})

describe('checkTaskTitle', () => {
  it.each([
    ['a plain title', 'Plan'],
    ['edge whitespace around a title', '  Plan  '],
    ['a decomposed accent', 'e\u0301'],
    ['an emoji', '🚀'],
  ])('accepts %s', (_label, raw) => {
    expect(checkTaskTitle(raw)).toBe('ok')
  })

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   \n\t'],
    ['ideographic space only', '\u3000'],
    ['zero-width marks only', '\u200B\u200C\u200D\uFEFF'],
    ['U+0000 inside', 'Pl\u0000an'],
    ['a lone high surrogate', 'Plan\uD83D'],
    ['a lone low surrogate', '\uDE80Plan'],
  ])('rejects %s with INVALID_TITLE', (_label, raw) => {
    expect(checkTaskTitle(raw)).toBe('INVALID_TITLE')
  })
})

describe('checkTaskDescription', () => {
  it('accepts an empty description and one at the code-point bound', () => {
    expect(checkTaskDescription('')).toBe('ok')
    expect(checkTaskDescription('🚀'.repeat(TASK_DESCRIPTION_MAX_CODEPOINTS))).toBe('ok')
  })

  it('rejects one code point over the bound, counting code points, not UTF-16 units', () => {
    expect(checkTaskDescription('🚀'.repeat(TASK_DESCRIPTION_MAX_CODEPOINTS + 1))).toBe('INVALID_DESCRIPTION')
    expect(checkTaskDescription('a'.repeat(TASK_DESCRIPTION_MAX_CODEPOINTS + 1))).toBe('INVALID_DESCRIPTION')
  })

  it('measures the text as given: no trimming, no normalization', () => {
    expect(checkTaskDescription('a'.repeat(TASK_DESCRIPTION_MAX_CODEPOINTS) + ' ')).toBe('INVALID_DESCRIPTION')
    expect(checkTaskDescription('e\u0301'.repeat(TASK_DESCRIPTION_MAX_CODEPOINTS))).toBe('INVALID_DESCRIPTION')
  })

  it('rejects U+0000 and a lone surrogate', () => {
    expect(checkTaskDescription('a\u0000b')).toBe('INVALID_DESCRIPTION')
    expect(checkTaskDescription('a\uD83D')).toBe('INVALID_DESCRIPTION')
  })
})

describe('checkTaskDates', () => {
  const dates = (over: Partial<Pick<TaskDraft, 'dueDate' | 'dueTime' | 'startDate' | 'startTime' | 'timeZone'>> = {}) => ({
    dueDate: null,
    dueTime: null,
    startDate: null,
    startTime: null,
    timeZone: '',
    ...over,
  })

  it('accepts no dates with no zone, and a dated draft with a zone', () => {
    expect(checkTaskDates(dates())).toEqual({ ok: true })
    expect(checkTaskDates(dates({ dueDate: '2031-03-15', dueTime: '23:59', timeZone: 'Asia/Shanghai' }))).toEqual({ ok: true })
    expect(checkTaskDates(dates({ startDate: '2032-02-29', timeZone: 'UTC' }))).toEqual({ ok: true })
  })

  it.each([
    ['a non-leap February 29th', '2031-02-29'],
    ['February 30th', '2031-02-30'],
    ['month 13', '2031-13-01'],
    ['month 00', '2031-00-10'],
    ['day 00', '2031-03-00'],
    ['an unpadded form', '2031-3-5'],
    ['digits without dashes', '20310315'],
    ['a two-digit-mapped year', '0031-01-01'],
    ['a date with a time', '2031-03-15T00:00'],
  ])('rejects %s as INVALID_DATE on the date field', (_label, dueDate) => {
    expect(checkTaskDates(dates({ dueDate, timeZone: 'UTC' }))).toEqual({ ok: false, code: 'INVALID_DATE', field: 'dueDate' })
    expect(checkTaskDates(dates({ startDate: dueDate, timeZone: 'UTC' }))).toEqual({ ok: false, code: 'INVALID_DATE', field: 'startDate' })
  })

  it.each([
    ['hour 24', '24:00'],
    ['minute 60', '23:60'],
    ['the seconds form', '10:00:00'],
    ['an unpadded hour', '9:00'],
    ['letters', 'ab:cd'],
  ])('rejects %s as INVALID_DATE on the time field', (_label, time) => {
    expect(checkTaskDates(dates({ dueDate: '2031-03-15', dueTime: time, timeZone: 'UTC' }))).toEqual({ ok: false, code: 'INVALID_DATE', field: 'dueTime' })
    expect(checkTaskDates(dates({ startDate: '2031-03-15', startTime: time, timeZone: 'UTC' }))).toEqual({ ok: false, code: 'INVALID_DATE', field: 'startTime' })
  })

  it('rejects a time without its date', () => {
    expect(checkTaskDates(dates({ dueTime: '10:00' }))).toEqual({ ok: false, code: 'INVALID_DATE', field: 'dueTime' })
    expect(checkTaskDates(dates({ startTime: '10:00', dueDate: '2031-03-15', timeZone: 'UTC' }))).toEqual({ ok: false, code: 'INVALID_DATE', field: 'startTime' })
  })

  it('requires a zone once any date is present', () => {
    expect(checkTaskDates(dates({ dueDate: '2031-03-15' }))).toEqual({ ok: false, code: 'TIME_ZONE_REQUIRED', field: 'timeZone' })
    expect(checkTaskDates(dates({ startDate: '2031-03-15' }))).toEqual({ ok: false, code: 'TIME_ZONE_REQUIRED', field: 'timeZone' })
  })

  it('accepts a case variant of a zone name and edge whitespace around it', () => {
    expect(checkTaskDates(dates({ dueDate: '2031-03-15', timeZone: 'asia/shanghai' }))).toEqual({ ok: true })
    expect(checkTaskDates(dates({ dueDate: '2031-03-15', timeZone: ' Asia/Shanghai ' }))).toEqual({ ok: true })
  })

  it.each([
    ['an offset form', '+08:00'],
    ['a bare Z', 'Z'],
    ['an unknown name', 'Not/AZone'],
    ['whitespace only', '   '],
    ['a compact offset', '+0800'],
  ])('rejects %s as INVALID_TIME_ZONE, with or without a date', (_label, timeZone) => {
    expect(checkTaskDates(dates({ dueDate: '2031-03-15', timeZone }))).toEqual({ ok: false, code: 'INVALID_TIME_ZONE', field: 'timeZone' })
    expect(checkTaskDates(dates({ timeZone }))).toEqual({ ok: false, code: 'INVALID_TIME_ZONE', field: 'timeZone' })
  })

  it('accepts a valid zone with no dates', () => {
    expect(checkTaskDates(dates({ timeZone: 'Asia/Tokyo' }))).toEqual({ ok: true })
  })

  it('reads an empty string on a date or time key as null (a cleared control)', () => {
    expect(checkTaskDates(dates({ dueDate: '', dueTime: '', startDate: '', startTime: '' }))).toEqual({ ok: true })
  })

  it('reports the server order: an invalid date before a missing zone, a zone problem before TIME_ZONE_REQUIRED', () => {
    expect(checkTaskDates(dates({ dueDate: '2031-02-30' }))).toEqual({ ok: false, code: 'INVALID_DATE', field: 'dueDate' })
    expect(checkTaskDates(dates({ dueDate: '2031-03-15', timeZone: 'Not/AZone' }))).toEqual({ ok: false, code: 'INVALID_TIME_ZONE', field: 'timeZone' })
  })
})

describe('checkRemindAt', () => {
  it.each([
    ['null (no reminder)', null],
    ['a toISOString instant', '2031-03-15T10:00:00.000Z'],
    ['the last instant of year 9999', '9999-12-31T23:59:59.999Z'],
    ['the first instant of year 0001', '0001-01-01T00:00:00.000Z'],
    ['a leap day', '2032-02-29T00:00:00.000Z'],
  ])('accepts %s', (_label, raw) => {
    expect(checkRemindAt(raw)).toBe('ok')
  })

  it.each([
    ['no milliseconds', '2031-03-15T10:00:00Z'],
    ['an offset instead of Z', '2031-03-15T10:00:00.000+08:00'],
    ['a lowercase t', '2031-03-15t10:00:00.000Z'],
    ['a lowercase z', '2031-03-15T10:00:00.000z'],
    ['a space separator', '2031-03-15 10:00:00.000Z'],
    ['four fraction digits', '2031-03-15T10:00:00.0000Z'],
    ['no seconds', '2031-03-15T10:00Z'],
    ['February 30th', '2031-02-30T10:00:00.000Z'],
    ['a non-leap February 29th', '2031-02-29T10:00:00.000Z'],
    ['month 13', '2031-13-01T10:00:00.000Z'],
    ['hour 24', '2031-03-15T24:00:00.000Z'],
    ['minute 60', '2031-03-15T10:60:00.000Z'],
    ['second 60', '2031-03-15T10:00:60.000Z'],
    ['year 0000', '0000-01-01T00:00:00.000Z'],
    ['an empty string', ''],
    ['a date only', '2031-03-15'],
  ])('rejects %s with INVALID_REMIND_AT', (_label, raw) => {
    expect(checkRemindAt(raw)).toBe('INVALID_REMIND_AT')
  })
})

describe('isValidTimeZoneName', () => {
  it.each(['Asia/Shanghai', 'asia/shanghai', 'UTC', ' UTC ', 'Etc/GMT+8', 'America/New_York'])('accepts %s', (zone) => {
    expect(isValidTimeZoneName(zone)).toBe(true)
  })

  it.each(['', '  ', '+08:00', '-05:00', '+0800', '+8', 'Z', 'z', 'Not/AZone', 'Asia/'])('rejects %s', (zone) => {
    expect(isValidTimeZoneName(zone)).toBe(false)
  })
})

describe('buildTaskPatch', () => {
  it('returns null for an unchanged draft taken from a server-shaped detail (seconds in the time, null description)', () => {
    expect(buildTaskPatch(serverTask, initDraft(serverTask))).toBeNull()
  })

  it("never treats '10:00:00' against '10:00', null against '' or a null zone against '' as a change", () => {
    const bare = { ...serverTask, dueDate: null, dueTime: null, timeZone: null, remindAt: null }
    expect(buildTaskPatch(bare, initDraft(bare))).toBeNull()
    expect(buildTaskPatch(serverTask, draftOf({ dueTime: '10:00', description: '' }))).toBeNull()
  })

  it('places only the title when only the title differs', () => {
    expect(buildTaskPatch(serverTask, draftOf({ title: 'New' }))).toStrictEqual({ title: 'New' })
  })

  it('compares the title normalized, and places a blank title as typed so the pre-check reports it', () => {
    expect(buildTaskPatch(serverTask, draftOf({ title: '  Plan ' }))).toBeNull()
    expect(buildTaskPatch(serverTask, draftOf({ title: ' New ' }))).toStrictEqual({ title: 'New' })
    const blank = buildTaskPatch(serverTask, draftOf({ title: '   ' }))
    expect(blank).toStrictEqual({ title: '   ' })
    expect(checkTaskTitle(blank?.title ?? '')).toBe('INVALID_TITLE')
  })

  it("places the description; clearing it sends ''", () => {
    expect(buildTaskPatch(serverTask, draftOf({ description: 'Notes' }))).toStrictEqual({ description: 'Notes' })
    const withDescription = { ...serverTask, description: 'Notes' }
    expect(buildTaskPatch(withDescription, { ...initDraft(withDescription), description: '' })).toStrictEqual({ description: '' })
  })

  it('a changed date or time carries the zone in the same body (the draft value, unchanged here)', () => {
    expect(buildTaskPatch(serverTask, draftOf({ dueDate: '2031-03-16' }))).toStrictEqual({ dueDate: '2031-03-16', timeZone: 'Asia/Shanghai' })
    expect(buildTaskPatch(serverTask, draftOf({ dueTime: '11:00' }))).toStrictEqual({ dueTime: '11:00', timeZone: 'Asia/Shanghai' })
    expect(buildTaskPatch(serverTask, draftOf({ startDate: '2031-03-10', startTime: '09:00' }))).toStrictEqual({
      startDate: '2031-03-10',
      startTime: '09:00',
      timeZone: 'Asia/Shanghai',
    })
  })

  it('adding a date to a task without one carries the draft zone; an empty draft zone is placed as null for the pre-check', () => {
    const bare = { ...serverTask, dueDate: null, dueTime: null, timeZone: null }
    expect(buildTaskPatch(bare, { ...initDraft(bare), dueDate: '2031-03-15', timeZone: 'Asia/Tokyo' })).toStrictEqual({
      dueDate: '2031-03-15',
      timeZone: 'Asia/Tokyo',
    })
    const noZone = { ...initDraft(bare), dueDate: '2031-03-15' }
    expect(buildTaskPatch(bare, noZone)).toStrictEqual({ dueDate: '2031-03-15', timeZone: null })
    expect(checkTaskDates(noZone)).toEqual({ ok: false, code: 'TIME_ZONE_REQUIRED', field: 'timeZone' })
  })

  it('clearing the due date sends its time as null in the same body, whether or not the draft still holds the time', () => {
    expect(buildTaskPatch(serverTask, draftOf({ dueDate: null, dueTime: null }))).toStrictEqual({ dueDate: null, dueTime: null })
    expect(buildTaskPatch(serverTask, draftOf({ dueDate: null }))).toStrictEqual({ dueDate: null, dueTime: null })
    expect(buildTaskPatch(serverTask, draftOf({ dueDate: '' }))).toStrictEqual({ dueDate: null, dueTime: null })
  })

  it('clearing the due date while a start date remains still carries the zone', () => {
    const both = { ...serverTask, startDate: '2031-03-10', startTime: '09:00:00' }
    expect(buildTaskPatch(both, { ...initDraft(both), dueDate: null, dueTime: null })).toStrictEqual({
      dueDate: null,
      dueTime: null,
      timeZone: 'Asia/Shanghai',
    })
    expect(buildTaskPatch(both, { ...initDraft(both), startDate: null })).toStrictEqual({
      startDate: null,
      startTime: null,
      timeZone: 'Asia/Shanghai',
    })
  })

  it('a zone change alone carries only the zone', () => {
    expect(buildTaskPatch(serverTask, draftOf({ timeZone: 'Asia/Tokyo' }))).toStrictEqual({ timeZone: 'Asia/Tokyo' })
  })

  it('clearing the zone on a dated task places timeZone null, which the pre-check then reports', () => {
    const draft = draftOf({ timeZone: '' })
    expect(buildTaskPatch(serverTask, draft)).toStrictEqual({ timeZone: null })
    expect(checkTaskDates(draft)).toEqual({ ok: false, code: 'TIME_ZONE_REQUIRED', field: 'timeZone' })
  })

  it('clearing the zone on a task without dates is exactly { timeZone: null }, and the pre-check accepts it', () => {
    const bare = { ...serverTask, dueDate: null, dueTime: null }
    const draft = { ...initDraft(bare), timeZone: '' }
    expect(buildTaskPatch(bare, draft)).toStrictEqual({ timeZone: null })
    expect(checkTaskDates(draft)).toEqual({ ok: true })
  })

  it('clearing every date leaves the zone alone when the draft zone is unchanged', () => {
    const both = { ...serverTask, startDate: '2031-03-10', startTime: null }
    expect(buildTaskPatch(both, { ...initDraft(both), dueDate: null, dueTime: null, startDate: null })).toStrictEqual({
      dueDate: null,
      dueTime: null,
      startDate: null,
    })
  })

  it('places remindAt only when touched, and only when it differs', () => {
    expect(buildTaskPatch(serverTask, draftOf({ remindAt: '2031-03-15T00:00:00.000Z' }))).toBeNull()
    expect(buildTaskPatch(serverTask, draftOf({ remindAt: '2031-03-15T00:00:00.000Z', remindTouched: true }))).toStrictEqual({
      remindAt: '2031-03-15T00:00:00.000Z',
    })
    expect(buildTaskPatch(serverTask, draftOf({ remindAt: null, remindTouched: true }))).toStrictEqual({ remindAt: null })
    expect(buildTaskPatch(serverTask, draftOf({ remindTouched: true }))).toBeNull()
  })

  it('never derives remindAt from a date change', () => {
    expect(buildTaskPatch(serverTask, draftOf({ dueDate: '2031-03-20' }))).toStrictEqual({ dueDate: '2031-03-20', timeZone: 'Asia/Shanghai' })
  })

  it('places several changed keys together, each in the canonical form', () => {
    expect(buildTaskPatch(serverTask, draftOf({
      title: 'New',
      description: 'd',
      dueTime: '12:30',
      timeZone: 'Asia/Tokyo',
      remindAt: null,
      remindTouched: true,
    }))).toStrictEqual({ title: 'New', description: 'd', dueTime: '12:30', timeZone: 'Asia/Tokyo', remindAt: null })
  })
})

// [fe-19] (ratified 2026-10-07): after a reload the draft keeps the fields the viewer changed and
// takes the reloaded value for the rest; the reminder counts as changed only when it was touched
// and differs from the value the draft was taken from.
describe('rebaseDraft ([fe-19])', () => {
  const REMIND = '2031-03-15T01:30:00.000Z'
  const THEIRS = '2031-03-14T01:30:00.000Z'

  it("a field the viewer changed keeps the viewer's value; every other field takes the reloaded value", () => {
    const base = initDraft(serverTask)
    const next = initDraft({ ...serverTask, title: 'Theirs', description: 'Their notes', timeZone: 'Asia/Tokyo' })
    const rebased = rebaseDraft(base, { ...base, title: 'Mine' }, next)
    expect(rebased).toStrictEqual({ ...next, title: 'Mine' })
    expect(buildTaskPatch({ ...serverTask, title: 'Theirs', description: 'Their notes', timeZone: 'Asia/Tokyo' }, rebased)).toStrictEqual({ title: 'Mine' })
  })

  it('a reminder touched and left at its value takes the reloaded value, counts as untouched, and the next patch has no remindAt', () => {
    const base = initDraft(serverTask)
    const nextTask = { ...serverTask, remindAt: THEIRS }
    const rebased = rebaseDraft(base, { ...base, title: 'Mine', remindAt: REMIND, remindTouched: true }, initDraft(nextTask))
    expect(rebased.remindAt).toBe(THEIRS)
    expect(rebased.remindTouched).toBe(false)
    expect(buildTaskPatch(nextTask, rebased)).toStrictEqual({ title: 'Mine' })
  })

  it("a reminder touched and changed keeps the viewer's value and stays touched", () => {
    const base = initDraft(serverTask)
    const nextTask = { ...serverTask, remindAt: THEIRS }
    const mine = '2031-03-16T01:30:00.000Z'
    const rebased = rebaseDraft(base, { ...base, remindAt: mine, remindTouched: true }, initDraft(nextTask))
    expect(rebased.remindAt).toBe(mine)
    expect(rebased.remindTouched).toBe(true)
    expect(buildTaskPatch(nextTask, rebased)).toStrictEqual({ remindAt: mine })
  })

  it('a reminder that differs without being touched takes the reloaded value', () => {
    const base = initDraft(serverTask)
    const rebased = rebaseDraft(base, { ...base, remindAt: '2031-03-16T01:30:00.000Z' }, initDraft({ ...serverTask, remindAt: THEIRS }))
    expect(rebased.remindAt).toBe(THEIRS)
    expect(rebased.remindTouched).toBe(false)
  })
})

describe('settings draft', () => {
  const settings: TaskSettings = { badgeScope: 'overdue', dailyReminderEnabled: false, defaultRemindPolicy: { mode: 'default' }, timeZone: null }

  it("initSettingsDraft reads a null zone as '' and copies the policy", () => {
    expect(initSettingsDraft(settings)).toStrictEqual({
      badgeScope: 'overdue',
      dailyReminderEnabled: false,
      defaultRemindPolicy: { mode: 'default' },
      timeZone: '',
    })
    expect(initSettingsDraft({ ...settings, timeZone: 'Asia/Shanghai' }).timeZone).toBe('Asia/Shanghai')
  })

  it('checkSettingsDraft accepts the closed-set values with an empty zone while the daily reminder is off', () => {
    expect(checkSettingsDraft(initSettingsDraft(settings))).toEqual({ ok: true })
    expect(checkSettingsDraft({ ...initSettingsDraft(settings), dailyReminderEnabled: true, timeZone: 'asia/shanghai' })).toEqual({ ok: true })
  })

  it('checkSettingsDraft reports a badge scope or policy mode outside the closed set', () => {
    expect(checkSettingsDraft({ ...initSettingsDraft(settings), badgeScope: 'all_open' })).toEqual({ ok: false, code: 'INVALID_BADGE_SCOPE', field: 'badgeScope' })
    expect(checkSettingsDraft({ ...initSettingsDraft(settings), defaultRemindPolicy: { mode: 'weekly' } })).toEqual({ ok: false, code: 'INVALID_POLICY', field: 'defaultRemindPolicy' })
  })

  it('checkSettingsDraft reports an invalid zone, and the daily reminder with no zone', () => {
    expect(checkSettingsDraft({ ...initSettingsDraft(settings), timeZone: 'Not/AZone' })).toEqual({ ok: false, code: 'INVALID_TIME_ZONE', field: 'timeZone' })
    expect(checkSettingsDraft({ ...initSettingsDraft(settings), timeZone: '+08:00' })).toEqual({ ok: false, code: 'INVALID_TIME_ZONE', field: 'timeZone' })
    expect(checkSettingsDraft({ ...initSettingsDraft(settings), dailyReminderEnabled: true })).toEqual({ ok: false, code: 'DAILY_REMINDER_REQUIRES_TIME_ZONE', field: 'timeZone' })
  })

  it('checkSettingsDraft reports in the server order: badge scope first, then policy, then the zone', () => {
    expect(checkSettingsDraft({ badgeScope: 'x', dailyReminderEnabled: true, defaultRemindPolicy: { mode: 'y' }, timeZone: '' })).toEqual({ ok: false, code: 'INVALID_BADGE_SCOPE', field: 'badgeScope' })
    expect(checkSettingsDraft({ badgeScope: 'off', dailyReminderEnabled: true, defaultRemindPolicy: { mode: 'y' }, timeZone: 'Not/AZone' })).toEqual({ ok: false, code: 'INVALID_POLICY', field: 'defaultRemindPolicy' })
    expect(checkSettingsDraft({ badgeScope: 'off', dailyReminderEnabled: true, defaultRemindPolicy: { mode: 'none' }, timeZone: 'Not/AZone' })).toEqual({ ok: false, code: 'INVALID_TIME_ZONE', field: 'timeZone' })
  })

  it('buildSettingsPatch returns null for an unchanged draft and places only the changed keys', () => {
    expect(buildSettingsPatch(settings, initSettingsDraft(settings))).toBeNull()
    expect(buildSettingsPatch(settings, { ...initSettingsDraft(settings), badgeScope: 'off' })).toStrictEqual({ badgeScope: 'off' })
    expect(buildSettingsPatch(settings, { ...initSettingsDraft(settings), dailyReminderEnabled: true, timeZone: 'Asia/Shanghai' })).toStrictEqual({
      dailyReminderEnabled: true,
      timeZone: 'Asia/Shanghai',
    })
    expect(buildSettingsPatch(settings, { ...initSettingsDraft(settings), defaultRemindPolicy: { mode: 'none' } })).toStrictEqual({
      defaultRemindPolicy: { mode: 'none' },
    })
  })

  it("buildSettingsPatch sends a cleared zone as null and never places badgeScope or the policy as null", () => {
    const zoned = { ...settings, timeZone: 'Asia/Shanghai' }
    expect(buildSettingsPatch(zoned, { ...initSettingsDraft(zoned), timeZone: '' })).toStrictEqual({ timeZone: null })
    expect(buildSettingsPatch(settings, { ...initSettingsDraft(settings), timeZone: '' })).toBeNull()
    const patch = buildSettingsPatch(settings, { ...initSettingsDraft(settings), badgeScope: 'off', defaultRemindPolicy: { mode: 'none' } })
    expect(patch?.badgeScope).toBe('off')
    expect(patch?.defaultRemindPolicy).toEqual({ mode: 'none' })
  })
})

describe('checkListName / checkGroupName', () => {
  it('accepts a name within the bound, counted in code points after trimming', () => {
    expect(checkListName('Launch')).toBe('ok')
    expect(checkListName('a'.repeat(TASK_NAME_MAX_CODEPOINTS))).toBe('ok')
    expect(checkListName('🚀'.repeat(TASK_NAME_MAX_CODEPOINTS))).toBe('ok')
    expect(checkListName('  ' + 'a'.repeat(TASK_NAME_MAX_CODEPOINTS) + '  ')).toBe('ok')
  })

  it('rejects a blank name as INVALID_NAME and one over the bound as NAME_TOO_LONG', () => {
    expect(checkListName('')).toBe('INVALID_NAME')
    expect(checkListName('   ')).toBe('INVALID_NAME')
    expect(checkListName('\u200B')).toBe('INVALID_NAME')
    expect(checkListName('a'.repeat(TASK_NAME_MAX_CODEPOINTS + 1))).toBe('NAME_TOO_LONG')
    expect(checkListName('🚀'.repeat(TASK_NAME_MAX_CODEPOINTS + 1))).toBe('NAME_TOO_LONG')
  })

  it('rejects U+0000 and a lone surrogate as INVALID_NAME', () => {
    expect(checkListName('a\u0000b')).toBe('INVALID_NAME')
    expect(checkListName('a\uD83D')).toBe('INVALID_NAME')
  })

  it('checkGroupName applies the same rules', () => {
    expect(checkGroupName('Doing')).toBe('ok')
    expect(checkGroupName('  ')).toBe('INVALID_NAME')
    expect(checkGroupName('a'.repeat(TASK_NAME_MAX_CODEPOINTS + 1))).toBe('NAME_TOO_LONG')
    expect(checkGroupName('a\u0000')).toBe('INVALID_NAME')
  })
})
