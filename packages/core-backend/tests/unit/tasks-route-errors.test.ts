/**
 * `sendError` in `routes/tasks.ts` (M3R2-AUTHZ-4, R3-TAM-5): an error thrown
 * by a task service is sent as `{ error: { code } }` only when it carries a
 * 4xx numeric `status` and a string `code`; anything else is 500
 * `{ error: { code: 'INTERNAL' } }` with no SQLSTATE and no message. The
 * trigger here is a stubbed service, independent of any input handling.
 */
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const createTask = vi.fn()
const patchTask = vi.fn()
const listService = {
  createTaskList: vi.fn(),
  getTaskList: vi.fn(),
  listTaskLists: vi.fn(),
  renameTaskList: vi.fn(),
  setTaskListArchived: vi.fn(),
  listTaskListEvents: vi.fn(),
  listTaskListMembers: vi.fn(),
  addTaskListMember: vi.fn(),
  changeTaskListMemberRole: vi.fn(),
  removeTaskListMember: vi.fn(),
  transferTaskListOwner: vi.fn(),
  listTaskListItems: vi.fn(),
  addTaskToList: vi.fn(),
  removeTaskFromList: vi.fn(),
}
const groupService = {
  listTaskListGroups: vi.fn(),
  createTaskListGroup: vi.fn(),
  renameTaskListGroup: vi.fn(),
  deleteTaskListGroup: vi.fn(),
  listTaskListGroupItems: vi.fn(),
  placeTaskInListGroup: vi.fn(),
  listUserTaskGroups: vi.fn(),
  createUserTaskGroup: vi.fn(),
  listUserTaskGroupItems: vi.fn(),
  placeTaskInUserGroup: vi.fn(),
  renameUserTaskGroup: vi.fn(),
  deleteUserTaskGroup: vi.fn(),
}

vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    ;(req as unknown as { user: unknown }).user = { id: 'usr_route_errors', sub: 'usr_route_errors' }
    ;(req as unknown as { authenticatedTenantId: string }).authenticatedTenantId = 'org_route_errors'
    next()
  }
  return { authenticate, default: authenticate }
})

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

vi.mock('../../src/services/task-records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/task-records')>()
  return { ...actual, createTask: (...args: unknown[]) => createTask(...args) }
})

vi.mock('../../src/services/task-patch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/task-patch')>()
  return { ...actual, patchTask: (...args: unknown[]) => patchTask(...args) }
})

vi.mock('../../src/services/task-list-records', () => ({
  createTaskList: (...args: unknown[]) => listService.createTaskList(...args),
  getTaskList: (...args: unknown[]) => listService.getTaskList(...args),
  listTaskLists: (...args: unknown[]) => listService.listTaskLists(...args),
  renameTaskList: (...args: unknown[]) => listService.renameTaskList(...args),
  setTaskListArchived: (...args: unknown[]) => listService.setTaskListArchived(...args),
  listTaskListEvents: (...args: unknown[]) => listService.listTaskListEvents(...args),
  listTaskListMembers: (...args: unknown[]) => listService.listTaskListMembers(...args),
  addTaskListMember: (...args: unknown[]) => listService.addTaskListMember(...args),
  changeTaskListMemberRole: (...args: unknown[]) => listService.changeTaskListMemberRole(...args),
  removeTaskListMember: (...args: unknown[]) => listService.removeTaskListMember(...args),
  transferTaskListOwner: (...args: unknown[]) => listService.transferTaskListOwner(...args),
  listTaskListItems: (...args: unknown[]) => listService.listTaskListItems(...args),
  addTaskToList: (...args: unknown[]) => listService.addTaskToList(...args),
  removeTaskFromList: (...args: unknown[]) => listService.removeTaskFromList(...args),
}))

vi.mock('../../src/services/task-group-records', () => Object.fromEntries(
  Object.keys(groupService).map((name) => [name, (...args: unknown[]) => groupService[name as keyof typeof groupService](...args)]),
))

const pinned = usePinnedServer()
const previousFlag = process.env.TASKS_ENABLED

beforeAll(async () => {
  process.env.TASKS_ENABLED = 'true'
  const { tasksRouter } = await import('../../src/routes/tasks')
  const router = tasksRouter()
  if (!router) throw new Error('tasks router not mounted')
  const app = express()
  app.use(express.json())
  app.use(router)
  pinned.setApp(app)
})

afterAll(() => {
  if (previousFlag === undefined) delete process.env.TASKS_ENABLED
  else process.env.TASKS_ENABLED = previousFlag
})

beforeEach(() => {
  createTask.mockReset()
  patchTask.mockReset()
  for (const fn of Object.values(listService)) fn.mockReset()
  for (const fn of Object.values(groupService)) fn.mockReset()
})

function pgShaped(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', detail: `detail ${message}` })
}

describe('tasks route sendError', () => {
  const internalCases: Array<{ label: string; error: unknown; secrets: string[] }> = [
    { label: 'pg-shaped error with a SQLSTATE', error: pgShaped('22021', 'invalid byte sequence for encoding "UTF8": 0x00'), secrets: ['22021', 'invalid byte sequence', 'UTF8'] },
    { label: 'non-4xx numeric status (503)', error: Object.assign(new Error('upstream down'), { status: 503, code: 'UPSTREAM_DOWN' }), secrets: ['UPSTREAM_DOWN', 'upstream down', '503'] },
    // M3R4-TAM-4: status exactly 500 with a string code is still INTERNAL.
    { label: 'status exactly 500 with a string code', error: Object.assign(new Error('boom'), { status: 500, code: 'X' }), secrets: ['X', 'boom'] },
    { label: '4xx status with a non-string code', error: Object.assign(new Error('odd'), { status: 422, code: 42 }), secrets: ['42', 'odd'] },
    { label: 'plain TypeError', error: new TypeError('cannot read x of undefined'), secrets: ['TypeError', 'cannot read'] },
  ]

  it.each(internalCases)('$label is 500 { code: INTERNAL } and echoes nothing', async ({ error, secrets }) => {
    createTask.mockRejectedValueOnce(error)
    const res = await request(pinned.url()).post('/api/tasks').send({ title: 't' })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: { code: 'INTERNAL' } })
    for (const secret of secrets) expect(res.text).not.toContain(secret)
  })

  it('a 4xx service error with a string code is sent as-is (control)', async () => {
    createTask.mockRejectedValueOnce(Object.assign(new Error('INVALID_TITLE'), { status: 422, code: 'INVALID_TITLE' }))
    const res = await request(pinned.url()).post('/api/tasks').send({ title: 't' })
    expect(res.status).toBe(422)
    expect(res.body).toEqual({ error: { code: 'INVALID_TITLE' } })
  })

  // M4 PR-3a S4: PATCH /api/tasks/:id goes through the same fallback.
  it.each(internalCases)('PATCH: $label is 500 { code: INTERNAL } and echoes nothing', async ({ error, secrets }) => {
    patchTask.mockRejectedValueOnce(error)
    const res = await request(pinned.url()).patch('/api/tasks/tsk_x').send({ expectedVersion: 1 })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: { code: 'INTERNAL' } })
    for (const secret of secrets) expect(res.text).not.toContain(secret)
  })

  it('PATCH: a version conflict is 409 with the code and currentVersion, nothing else', async () => {
    patchTask.mockRejectedValueOnce(Object.assign(new Error('VERSION_CONFLICT'), { status: 409, code: 'VERSION_CONFLICT', currentVersion: 7 }))
    const res = await request(pinned.url()).patch('/api/tasks/tsk_x').send({ expectedVersion: 1 })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: { code: 'VERSION_CONFLICT' }, currentVersion: 7 })
  })

  it('PATCH: a conflict-coded error without an integer currentVersion is not given the extra key', async () => {
    patchTask.mockRejectedValueOnce(Object.assign(new Error('VERSION_CONFLICT'), { status: 409, code: 'VERSION_CONFLICT', currentVersion: 'DROP' }))
    const res = await request(pinned.url()).patch('/api/tasks/tsk_x').send({ expectedVersion: 1 })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: { code: 'VERSION_CONFLICT' } })
  })

  it('PATCH: the service receives the path id and the raw body', async () => {
    patchTask.mockResolvedValueOnce({ id: 'tsk_x', version: 2 })
    const res = await request(pinned.url()).patch('/api/tasks/tsk_x').send({ expectedVersion: 1, title: 't' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'tsk_x', version: 2 })
    expect(patchTask).toHaveBeenCalledWith({
      orgId: 'org_route_errors', actorId: 'usr_route_errors', taskId: 'tsk_x', body: { expectedVersion: 1, title: 't' },
    })
  })

  // M4 PR-3a S5: every task-list route goes through the same fallback, and hands the service the
  // path id, the raw body and the raw query values.
  const listRoutes: Array<{ label: string; service: keyof typeof listService; method: 'get' | 'post' | 'patch' | 'delete'; path: string; body?: unknown }> = [
    { label: 'POST /api/task-lists', service: 'createTaskList', method: 'post', path: '/api/task-lists', body: { name: 'n' } },
    { label: 'GET /api/task-lists', service: 'listTaskLists', method: 'get', path: '/api/task-lists' },
    { label: 'GET /api/task-lists/:id', service: 'getTaskList', method: 'get', path: '/api/task-lists/tlst_x' },
    { label: 'PATCH /api/task-lists/:id', service: 'renameTaskList', method: 'patch', path: '/api/task-lists/tlst_x', body: { name: 'n' } },
    { label: 'POST /api/task-lists/:id/archive', service: 'setTaskListArchived', method: 'post', path: '/api/task-lists/tlst_x/archive' },
    { label: 'POST /api/task-lists/:id/unarchive', service: 'setTaskListArchived', method: 'post', path: '/api/task-lists/tlst_x/unarchive' },
    { label: 'GET /api/task-lists/:id/events', service: 'listTaskListEvents', method: 'get', path: '/api/task-lists/tlst_x/events' },
    // S6
    { label: 'GET /api/task-lists/:id/members', service: 'listTaskListMembers', method: 'get', path: '/api/task-lists/tlst_x/members' },
    { label: 'POST /api/task-lists/:id/members', service: 'addTaskListMember', method: 'post', path: '/api/task-lists/tlst_x/members', body: { userId: 'u', role: 'read' } },
    { label: 'PATCH /api/task-lists/:id/members/:userId', service: 'changeTaskListMemberRole', method: 'patch', path: '/api/task-lists/tlst_x/members/usr_y', body: { role: 'read' } },
    { label: 'DELETE /api/task-lists/:id/members/:userId', service: 'removeTaskListMember', method: 'delete', path: '/api/task-lists/tlst_x/members/usr_y' },
    { label: 'POST /api/task-lists/:id/transfer-owner', service: 'transferTaskListOwner', method: 'post', path: '/api/task-lists/tlst_x/transfer-owner', body: { userId: 'u' } },
    // S7
    { label: 'GET /api/task-lists/:id/items', service: 'listTaskListItems', method: 'get', path: '/api/task-lists/tlst_x/items' },
    { label: 'POST /api/task-lists/:id/items', service: 'addTaskToList', method: 'post', path: '/api/task-lists/tlst_x/items', body: { taskId: 'tsk_y' } },
    { label: 'DELETE /api/task-lists/:id/items/:taskId', service: 'removeTaskFromList', method: 'delete', path: '/api/task-lists/tlst_x/items/tsk_y' },
  ]

  it.each(listRoutes)('$label: a driver error is 500 { code: INTERNAL } and echoes nothing', async ({ service, method, path, body }) => {
    listService[service].mockRejectedValueOnce(pgShaped('22021', 'invalid byte sequence for encoding "UTF8": 0x00'))
    const call = request(pinned.url())[method](path)
    const res = body === undefined ? await call : await call.send(body as object)
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: { code: 'INTERNAL' } })
    for (const secret of ['22021', 'invalid byte sequence', 'UTF8']) expect(res.text).not.toContain(secret)
  })

  it('task-list routes: the services receive the path id, the raw body and the raw query values', async () => {
    for (const fn of Object.values(listService)) fn.mockResolvedValue({ ok: true })
    const base = { orgId: 'org_route_errors', actorId: 'usr_route_errors' }
    await request(pinned.url()).post('/api/task-lists').send({ name: 'n', extra: 1 })
    expect(listService.createTaskList).toHaveBeenCalledWith({ ...base, body: { name: 'n', extra: 1 } })
    await request(pinned.url()).get('/api/task-lists?limit=5&offset=1&includeArchived=true')
    expect(listService.listTaskLists).toHaveBeenCalledWith({ ...base, query: { limit: '5', offset: '1', includeArchived: 'true' } })
    await request(pinned.url()).get('/api/task-lists/tlst_x')
    expect(listService.getTaskList).toHaveBeenCalledWith({ ...base, listId: 'tlst_x' })
    await request(pinned.url()).patch('/api/task-lists/tlst_x').send({ name: 'n' })
    expect(listService.renameTaskList).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', body: { name: 'n' } })
    await request(pinned.url()).post('/api/task-lists/tlst_x/archive')
    expect(listService.setTaskListArchived).toHaveBeenLastCalledWith({ ...base, listId: 'tlst_x', archived: true })
    await request(pinned.url()).post('/api/task-lists/tlst_x/unarchive')
    expect(listService.setTaskListArchived).toHaveBeenLastCalledWith({ ...base, listId: 'tlst_x', archived: false })
    await request(pinned.url()).get('/api/task-lists/tlst_x/events?limit=2')
    expect(listService.listTaskListEvents).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', query: { limit: '2', offset: undefined } })
  })

  it('member routes (S6): the services receive the path ids, the raw body and the raw query values', async () => {
    for (const fn of Object.values(listService)) fn.mockResolvedValue({ ok: true })
    const base = { orgId: 'org_route_errors', actorId: 'usr_route_errors' }
    await request(pinned.url()).get('/api/task-lists/tlst_x/members?limit=3&offset=4')
    expect(listService.listTaskListMembers).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', query: { limit: '3', offset: '4' } })
    await request(pinned.url()).post('/api/task-lists/tlst_x/members').send({ userId: 'usr_y', role: 'owner', extra: 1 })
    expect(listService.addTaskListMember).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', body: { userId: 'usr_y', role: 'owner', extra: 1 } })
    await request(pinned.url()).patch('/api/task-lists/tlst_x/members/usr_y').send({ role: 7 })
    expect(listService.changeTaskListMemberRole).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', userId: 'usr_y', body: { role: 7 } })
    await request(pinned.url()).delete('/api/task-lists/tlst_x/members/usr_y')
    expect(listService.removeTaskListMember).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', userId: 'usr_y' })
    await request(pinned.url()).post('/api/task-lists/tlst_x/transfer-owner').send({ userId: 'usr_y' })
    expect(listService.transferTaskListOwner).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', body: { userId: 'usr_y' } })
  })

  it('item routes (S7): the services receive the path ids, the raw body and the raw query values', async () => {
    for (const fn of Object.values(listService)) fn.mockResolvedValue({ ok: true })
    const base = { orgId: 'org_route_errors', actorId: 'usr_route_errors' }
    await request(pinned.url()).get('/api/task-lists/tlst_x/items?limit=3&offset=4')
    expect(listService.listTaskListItems).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', query: { limit: '3', offset: '4' } })
    await request(pinned.url()).post('/api/task-lists/tlst_x/items').send({ taskId: 7, extra: 1 })
    expect(listService.addTaskToList).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', body: { taskId: 7, extra: 1 } })
    await request(pinned.url()).delete('/api/task-lists/tlst_x/items/tsk_y')
    expect(listService.removeTaskFromList).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', taskId: 'tsk_y' })
  })

  // M4 PR-3a S8: the twelve group routes go through the same fallback, and hand the service the path
  // ids, the raw body and the raw query values.
  const groupRoutes: Array<{ label: string; service: keyof typeof groupService; method: 'get' | 'post' | 'patch' | 'put' | 'delete'; path: string; body?: unknown }> = [
    { label: 'GET /api/task-lists/:id/groups', service: 'listTaskListGroups', method: 'get', path: '/api/task-lists/tlst_x/groups' },
    { label: 'POST /api/task-lists/:id/groups', service: 'createTaskListGroup', method: 'post', path: '/api/task-lists/tlst_x/groups', body: { name: 'n' } },
    { label: 'PATCH /api/task-lists/:id/groups/:groupId', service: 'renameTaskListGroup', method: 'patch', path: '/api/task-lists/tlst_x/groups/tgrp_y', body: { name: 'n' } },
    { label: 'DELETE /api/task-lists/:id/groups/:groupId', service: 'deleteTaskListGroup', method: 'delete', path: '/api/task-lists/tlst_x/groups/tgrp_y' },
    { label: 'GET /api/task-lists/:id/group-items', service: 'listTaskListGroupItems', method: 'get', path: '/api/task-lists/tlst_x/group-items' },
    { label: 'PUT /api/task-lists/:id/group-items/:taskId', service: 'placeTaskInListGroup', method: 'put', path: '/api/task-lists/tlst_x/group-items/tsk_y', body: { groupId: null, position: 0 } },
    { label: 'GET /api/task-groups', service: 'listUserTaskGroups', method: 'get', path: '/api/task-groups' },
    { label: 'POST /api/task-groups', service: 'createUserTaskGroup', method: 'post', path: '/api/task-groups', body: { name: 'n' } },
    { label: 'GET /api/task-groups/items', service: 'listUserTaskGroupItems', method: 'get', path: '/api/task-groups/items' },
    { label: 'PUT /api/task-groups/items/:taskId', service: 'placeTaskInUserGroup', method: 'put', path: '/api/task-groups/items/tsk_y', body: { groupId: null, position: 0 } },
    { label: 'PATCH /api/task-groups/:groupId', service: 'renameUserTaskGroup', method: 'patch', path: '/api/task-groups/tgrp_y', body: { name: 'n' } },
    { label: 'DELETE /api/task-groups/:groupId', service: 'deleteUserTaskGroup', method: 'delete', path: '/api/task-groups/tgrp_y' },
  ]

  it.each(groupRoutes)('$label: a driver error is 500 { code: INTERNAL } and echoes nothing', async ({ service, method, path, body }) => {
    groupService[service].mockRejectedValueOnce(pgShaped('22021', 'invalid byte sequence for encoding "UTF8": 0x00'))
    const call = request(pinned.url())[method](path)
    const res = body === undefined ? await call : await call.send(body as object)
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: { code: 'INTERNAL' } })
    for (const secret of ['22021', 'invalid byte sequence', 'UTF8']) expect(res.text).not.toContain(secret)
    expect(groupService[service]).toHaveBeenCalledTimes(1)
  })

  it('group routes (S8): the services receive the path ids, the raw body and the raw query values', async () => {
    for (const fn of Object.values(groupService)) fn.mockResolvedValue({ ok: true })
    const base = { orgId: 'org_route_errors', actorId: 'usr_route_errors' }
    await request(pinned.url()).get('/api/task-lists/tlst_x/groups?limit=3&offset=4')
    expect(groupService.listTaskListGroups).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', query: { limit: '3', offset: '4' } })
    await request(pinned.url()).post('/api/task-lists/tlst_x/groups').send({ name: 7, extra: 1 })
    expect(groupService.createTaskListGroup).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', body: { name: 7, extra: 1 } })
    await request(pinned.url()).patch('/api/task-lists/tlst_x/groups/tgrp_y').send({ name: 'n' })
    expect(groupService.renameTaskListGroup).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', groupId: 'tgrp_y', body: { name: 'n' } })
    await request(pinned.url()).delete('/api/task-lists/tlst_x/groups/tgrp_y')
    expect(groupService.deleteTaskListGroup).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', groupId: 'tgrp_y' })
    await request(pinned.url()).get('/api/task-lists/tlst_x/group-items?limit=2')
    expect(groupService.listTaskListGroupItems).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', query: { limit: '2', offset: undefined } })
    await request(pinned.url()).put('/api/task-lists/tlst_x/group-items/tsk_y').send({ groupId: 'tgrp_y', position: '1' })
    expect(groupService.placeTaskInListGroup).toHaveBeenCalledWith({ ...base, listId: 'tlst_x', taskId: 'tsk_y', body: { groupId: 'tgrp_y', position: '1' } })
    await request(pinned.url()).get('/api/task-groups?offset=6')
    expect(groupService.listUserTaskGroups).toHaveBeenCalledWith({ ...base, query: { limit: undefined, offset: '6' } })
    await request(pinned.url()).post('/api/task-groups').send({ name: 'n' })
    expect(groupService.createUserTaskGroup).toHaveBeenCalledWith({ ...base, body: { name: 'n' } })
    await request(pinned.url()).get('/api/task-groups/items?limit=5&offset=0')
    expect(groupService.listUserTaskGroupItems).toHaveBeenCalledWith({ ...base, query: { limit: '5', offset: '0' } })
    await request(pinned.url()).put('/api/task-groups/items/tsk_y').send({ groupId: null, position: 0 })
    expect(groupService.placeTaskInUserGroup).toHaveBeenCalledWith({ ...base, taskId: 'tsk_y', body: { groupId: null, position: 0 } })
    await request(pinned.url()).patch('/api/task-groups/tgrp_y').send({ name: 'n' })
    expect(groupService.renameUserTaskGroup).toHaveBeenCalledWith({ ...base, groupId: 'tgrp_y', body: { name: 'n' } })
    await request(pinned.url()).delete('/api/task-groups/tgrp_y')
    expect(groupService.deleteUserTaskGroup).toHaveBeenCalledWith({ ...base, groupId: 'tgrp_y' })
  })
})
