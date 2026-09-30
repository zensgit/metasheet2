import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Task-feature-line M3 frontend API client tests (backend contract
 * `docs/development/task-m3-backend-design-20260928.md`, §3.1, §3.3-§3.7). The backend is NOT
 * implemented yet — `tasksApi.ts`'s M3 functions are coded only against that contract; every test
 * here mocks `apiFetch` the same way `tasks-api.spec.ts` does for the M2 calls.
 *
 * Every M3 WRITE function shares ONE non-2xx classifier (`classifyWriteFailure` in tasksApi.ts):
 * 403 -> forbidden, 404 -> not_found, a 409 with a parseable `error.code` -> conflict, a 422 with
 * `error.code === 'ORG_MISSING'` -> org_missing, any OTHER 422 code -> validation, anything
 * unparseable -> error. Each `describe` below exercises its OWN endpoint's path/method/body and
 * its OWN documented codes; the shared classifier's generic edges (409/422 with no parseable
 * code, an unrecognized code) are exercised once each on `setParent` and once on `deleteTask` —
 * not repeated on every single endpoint, since the mapping code path is identical byte-for-byte.
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
  checkCommentBody,
  createComment,
  deleteComment,
  deleteTask,
  editComment,
  getTask,
  isPathSafeSegment,
  leaveTask,
  COMMENTS_MAX_PAGES,
  COMMENTS_PAGE_LIMIT,
  listComments,
  removeAssignee,
  removeFollower,
  setCompletionMode,
  setParent,
} from '../src/tasks/tasksApi'

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

beforeEach(() => {
  h.apiFetch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('setParent', () => {
  it('PATCHes /api/tasks/:id/parent with the given parentId and resolves ok', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1', parentId: 'p1', depth: 1 }))
    const result = await setParent('t1', 'p1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/parent')
    expect(options?.method).toBe('PATCH')
    expect(JSON.parse(options?.body as string)).toEqual({ parentId: 'p1' })
    expect(result).toEqual({ kind: 'ok', id: 't1', parentId: 'p1', depth: 1 })
  })

  it('sends parentId: null to clear the parent, and resolves ok with parentId null', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1', parentId: null, depth: 0 }))
    await setParent('t1', null)
    const [, options] = lastCall()
    expect(JSON.parse(options?.body as string)).toEqual({ parentId: null })
    await expect(setParent('t1', null)).resolves.toEqual({ kind: 'ok', id: 't1', parentId: null, depth: 0 })
  })

  it('URI-encodes the id', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't 1', parentId: null, depth: 0 }))
    await setParent('t 1', null)
    expect(lastCall()[0]).toBe('/api/tasks/t%201/parent')
  })

  it('resolves not_found for a 404', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'not_found' })
  })

  it('resolves forbidden for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'forbidden' })
  })

  it('resolves org_missing for a 422 with error.code ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'org_missing' })
  })

  it('resolves validation INVALID_PARENT for a 422 with that code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'INVALID_PARENT' } }))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'validation', code: 'INVALID_PARENT' })
  })

  it('resolves validation DEPTH_EXCEEDED for a 422 with that code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'DEPTH_EXCEEDED' } }))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'validation', code: 'DEPTH_EXCEEDED' })
  })

  it('resolves error for a 422 with no parseable error.code (shared classifier edge)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, {}))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'error', status: 422 })
  })

  it('resolves conflict for an undocumented 409 that carries a code (shared classifier)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(409, { error: { code: 'SOMETHING' } }))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'conflict', code: 'SOMETHING' })
  })

  it('resolves error for a 409 with no parseable error.code (shared classifier edge)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(409, null))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'error', status: 409 })
  })

  it('resolves error for a 500', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(500, null))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'error', status: 500 })
  })

  it.each([
    ['missing id', (b: Record<string, unknown>) => { delete b.id }],
    ['parentId wrong type', (b: Record<string, unknown>) => { b.parentId = 5 }],
    ['depth missing', (b: Record<string, unknown>) => { delete b.depth }],
    ['depth non-finite', (b: Record<string, unknown>) => { b.depth = Number.POSITIVE_INFINITY }],
  ])('resolves error for a malformed 200 body: %s', async (_label, corrupt) => {
    const body: Record<string, unknown> = { id: 't1', parentId: 'p1', depth: 1 }
    corrupt(body)
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves error when apiFetch rejects (network failure)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(setParent('t1', 'p1')).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

describe('addAssignee / removeAssignee', () => {
  const membershipBody = {
    id: 't1',
    status: 'open',
    completionMode: 'all',
    assignees: [{ userId: 'u1', completedAt: null }],
  }

  it('POSTs /api/tasks/:id/assignees with userId and resolves ok with the membership state', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, membershipBody))
    const result = await addAssignee('t1', 'u1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/assignees')
    expect(options?.method).toBe('POST')
    expect(JSON.parse(options?.body as string)).toEqual({ userId: 'u1' })
    expect(result).toEqual({ kind: 'ok', task: membershipBody })
  })

  it('DELETEs /api/tasks/:id/assignees/:userId with no body and resolves ok', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, membershipBody))
    const result = await removeAssignee('t1', 'u1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/assignees/u1')
    expect(options?.method).toBe('DELETE')
    expect(options?.body).toBeUndefined()
    expect(result).toEqual({ kind: 'ok', task: membershipBody })
  })

  it('URI-encodes the userId on remove', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, membershipBody))
    await removeAssignee('t1', 'u 1')
    expect(lastCall()[0]).toBe('/api/tasks/t1/assignees/u%201')
  })

  it('add resolves validation INVALID_ASSIGNEES for a 422 with that code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'INVALID_ASSIGNEES' } }))
    await expect(addAssignee('t1', 'u1')).resolves.toEqual({ kind: 'validation', code: 'INVALID_ASSIGNEES' })
  })

  it('add resolves validation LIMIT for a 422 with that code (>50 assignees)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'LIMIT' } }))
    await expect(addAssignee('t1', 'u1')).resolves.toEqual({ kind: 'validation', code: 'LIMIT' })
  })

  it('add resolves org_missing for a 422 with error.code ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(addAssignee('t1', 'u1')).resolves.toEqual({ kind: 'org_missing' })
  })

  it('remove resolves not_found for a 404', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(removeAssignee('t1', 'u1')).resolves.toEqual({ kind: 'not_found' })
  })

  it('remove resolves forbidden for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(removeAssignee('t1', 'u1')).resolves.toEqual({ kind: 'forbidden' })
  })

  it.each([
    ['missing id', (b: Record<string, unknown>) => { delete b.id }],
    ['bad status literal', (b: Record<string, unknown>) => { b.status = 'closed' }],
    ['bad completionMode literal', (b: Record<string, unknown>) => { b.completionMode = 'some' }],
    ['assignees not an array', (b: Record<string, unknown>) => { b.assignees = {} }],
    ['assignee missing userId', (b: Record<string, unknown>) => { b.assignees = [{ completedAt: null }] }],
  ])('add resolves error for a malformed 200 body: %s', async (_label, corrupt) => {
    const body = { ...membershipBody, assignees: [...membershipBody.assignees] } as Record<string, unknown>
    corrupt(body)
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(addAssignee('t1', 'u1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves error when apiFetch rejects (network failure)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(addAssignee('t1', 'u1')).resolves.toEqual({ kind: 'error', status: 0 })
    await expect(removeAssignee('t1', 'u1')).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

describe('setCompletionMode', () => {
  const membershipBody = { id: 't1', status: 'open', completionMode: 'any', assignees: [] }

  it('PATCHes /api/tasks/:id/completion-mode with completionMode and resolves ok', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, membershipBody))
    const result = await setCompletionMode('t1', 'any')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/completion-mode')
    expect(options?.method).toBe('PATCH')
    expect(JSON.parse(options?.body as string)).toEqual({ completionMode: 'any' })
    expect(result).toEqual({ kind: 'ok', task: membershipBody })
  })

  it('resolves validation INVALID_MODE for a 422 with that code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'INVALID_MODE' } }))
    await expect(setCompletionMode('t1', 'all')).resolves.toEqual({ kind: 'validation', code: 'INVALID_MODE' })
  })

  it('resolves org_missing for a 422 with error.code ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(setCompletionMode('t1', 'all')).resolves.toEqual({ kind: 'org_missing' })
  })

  it('resolves not_found for a 404', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(setCompletionMode('t1', 'all')).resolves.toEqual({ kind: 'not_found' })
  })
})

describe('addFollower / removeFollower / leaveTask', () => {
  const followersBody = { id: 't1', followers: ['u1', 'u2'] }

  it('POSTs /api/tasks/:id/followers with userId and resolves ok', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, followersBody))
    const result = await addFollower('t1', 'u1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/followers')
    expect(options?.method).toBe('POST')
    expect(JSON.parse(options?.body as string)).toEqual({ userId: 'u1' })
    expect(result).toEqual({ kind: 'ok', task: followersBody })
  })

  it('DELETEs /api/tasks/:id/followers/:userId with no body and resolves ok', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, followersBody))
    const result = await removeFollower('t1', 'u1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/followers/u1')
    expect(options?.method).toBe('DELETE')
    expect(options?.body).toBeUndefined()
    expect(result).toEqual({ kind: 'ok', task: followersBody })
  })

  it('POSTs /api/tasks/:id/leave with no body and resolves ok', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, followersBody))
    const result = await leaveTask('t1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/leave')
    expect(options?.method).toBe('POST')
    expect(options?.body).toBeUndefined()
    expect(result).toEqual({ kind: 'ok', task: followersBody })
  })

  it('leave resolves not_found for a 404 (non-follower — §3.5: leave is follower-only)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(leaveTask('t1')).resolves.toEqual({ kind: 'not_found' })
  })

  it('add resolves validation LIMIT for a 422 with that code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'LIMIT' } }))
    await expect(addFollower('t1', 'u1')).resolves.toEqual({ kind: 'validation', code: 'LIMIT' })
  })

  it('add resolves validation INVALID_ASSIGNEES for a 422 with that code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'INVALID_ASSIGNEES' } }))
    await expect(addFollower('t1', 'u1')).resolves.toEqual({ kind: 'validation', code: 'INVALID_ASSIGNEES' })
  })

  it.each([
    ['missing id', (b: Record<string, unknown>) => { delete b.id }],
    ['followers not an array', (b: Record<string, unknown>) => { b.followers = {} }],
    ['followers entry not a string', (b: Record<string, unknown>) => { b.followers = [1] }],
  ])('resolves error for a malformed 200 body: %s', async (_label, corrupt) => {
    const body: Record<string, unknown> = { id: 't1', followers: ['u1'] }
    corrupt(body)
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(addFollower('t1', 'u1')).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

describe('listComments', () => {
  const commentBody = {
    id: 'c1',
    taskId: 't1',
    authorId: 'u1',
    body: 'hello',
    deleted: false,
    createdAt: '2026-09-28T00:00:00.000Z',
  }

  it('GETs /api/tasks/:id/comments with an explicit page and resolves ok with items and total', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [commentBody], total: 1 }))
    const result = await listComments('t1')
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
    expect(lastCall()[0]).toBe('/api/tasks/t1/comments?limit=100&offset=0')
    expect(result).toEqual({ kind: 'ok', items: [commentBody], total: 1 })
  })

  it('resolves ok with an empty items array', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], total: 0 }))
    await expect(listComments('t1')).resolves.toEqual({ kind: 'ok', items: [], total: 0 })
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
  })

  it('resolves ok with a tombstone (deleted: true, body: null)', async () => {
    const tombstone = { ...commentBody, deleted: true, body: null }
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [tombstone], total: 1 }))
    await expect(listComments('t1')).resolves.toEqual({ kind: 'ok', items: [tombstone], total: 1 })
  })

  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_unused, index) => ({ ...commentBody, id: `c${from + index}` }))

  it('reads every page: 250 comments take three requests at offsets 0, 100, 200, in server order', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: page(0, 100), total: 250 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: page(100, 100), total: 250 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: page(200, 50), total: 250 }))
    const result = await listComments('t1')
    expect(h.apiFetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/tasks/t1/comments?limit=100&offset=0',
      '/api/tasks/t1/comments?limit=100&offset=100',
      '/api/tasks/t1/comments?limit=100&offset=200',
    ])
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.total).toBe(250)
    expect(result.items.map((item) => item.id)).toEqual(page(0, 250).map((item) => item.id))
  })

  it('a short page before total is reached advances the offset by rows read, not by page index', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: page(0, 60), total: 130 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: page(60, 70), total: 130 }))
    const result = await listComments('t1')
    expect(h.apiFetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/tasks/t1/comments?limit=100&offset=0',
      '/api/tasks/t1/comments?limit=100&offset=60',
    ])
    expect(result).toMatchObject({ kind: 'ok', total: 130 })
    if (result.kind === 'ok') expect(result.items).toHaveLength(130)
  })

  it('a row that arrives on two pages (a comment landed between the reads) is kept once', async () => {
    // Page 1 ends with c99; a comment that sorts earlier commits before page 2 is read, so c99
    // is pushed to offset 100 and arrives again.
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: page(0, 100), total: 101 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: page(99, 1), total: 101 }))
    const result = await listComments('t1')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.items).toHaveLength(100)
    expect(new Set(result.items.map((item) => item.id)).size).toBe(100)
    expect(result.total).toBe(101)
  })

  it('after a repeated row the next offset still counts rows read, so no later row is re-read or skipped', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: page(0, 100), total: 200 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: page(99, 100), total: 201 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: page(199, 1), total: 201 }))
    const result = await listComments('t1')
    expect(h.apiFetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/tasks/t1/comments?limit=100&offset=0',
      '/api/tasks/t1/comments?limit=100&offset=100',
      '/api/tasks/t1/comments?limit=100&offset=200',
    ])
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.items.map((item) => item.id)).toEqual(page(0, 200).map((item) => item.id))
    expect(result.total).toBe(201)
  })

  it('stops requesting further pages once the caller says the read is superseded', async () => {
    h.apiFetch.mockImplementation(async () => jsonResponse(200, { items: page(0, 100), total: 1000 }))
    let superseded = false
    const pending = listComments('t1', { isSuperseded: () => superseded })
    superseded = true
    await pending
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
  })

  it('exactly 100 comments is one request (no empty trailing page)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: page(0, 100), total: 100 }))
    const result = await listComments('t1')
    expect(h.apiFetch).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ kind: 'ok', total: 100 })
  })

  it('a later page failing fails the whole read — never a partial thread as ok', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: page(0, 100), total: 150 }))
      .mockResolvedValueOnce(jsonResponse(500, null))
    await expect(listComments('t1')).resolves.toEqual({ kind: 'error', status: 500 })
  })

  it('an empty page before total is reached stops the loop and reports the shortfall', async () => {
    h.apiFetch
      .mockResolvedValueOnce(jsonResponse(200, { items: page(0, 100), total: 150 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [], total: 150 }))
    const result = await listComments('t1')
    expect(h.apiFetch).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ kind: 'ok', total: 150 })
    if (result.kind === 'ok') expect(result.items).toHaveLength(100)
  })

  it('stops at COMMENTS_MAX_PAGES and reports items.length < total', async () => {
    let served = 0
    h.apiFetch.mockImplementation(async () => {
      const body = { items: page(served, COMMENTS_PAGE_LIMIT), total: 1_000_000 }
      served += COMMENTS_PAGE_LIMIT
      return jsonResponse(200, body)
    })
    const result = await listComments('t1')
    expect(h.apiFetch).toHaveBeenCalledTimes(COMMENTS_MAX_PAGES)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.items).toHaveLength(COMMENTS_PAGE_LIMIT * COMMENTS_MAX_PAGES)
    expect(result.total).toBe(1_000_000)
  })

  it.each([
    ['total missing', { items: [] }],
    ['total not a number', { items: [], total: '0' }],
    ['total negative', { items: [], total: -1 }],
    ['total fractional', { items: [], total: 1.5 }],
  ])('resolves error for a 200 whose page envelope is malformed: %s', async (_label, body) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(listComments('t1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves not_found for a 404 (no org_missing kind for this READ — mirrors getTask)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(listComments('t1')).resolves.toEqual({ kind: 'not_found' })
  })

  it('resolves forbidden for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(listComments('t1')).resolves.toEqual({ kind: 'forbidden' })
  })

  it('a 422 with error.code ORG_MISSING resolves as a plain error, not org_missing', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    const result = await listComments('t1')
    expect(result).toEqual({ kind: 'error', status: 422 })
  })

  it.each([
    ['deleted true but body not null', () => ({ ...commentBody, deleted: true })],
    ['deleted false but body null', () => ({ ...commentBody, body: null })],
    ['missing authorId', () => { const b = { ...commentBody } as Record<string, unknown>; delete b.authorId; return b }],
    ['createdAt wrong type', () => ({ ...commentBody, createdAt: 123 })],
  ])('resolves error for a malformed comment row: %s', async (_label, build) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [build()], total: 1 }))
    await expect(listComments('t1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves error for a 200 with items not an array', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: 'nope', total: 0 }))
    await expect(listComments('t1')).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

describe('createComment / editComment / deleteComment', () => {
  const liveComment = {
    id: 'c1',
    taskId: 't1',
    authorId: 'u1',
    body: 'hello',
    deleted: false,
    createdAt: '2026-09-28T00:00:00.000Z',
  }
  const tombstone = { ...liveComment, deleted: true, body: null }

  it('POSTs /api/tasks/:id/comments with body and resolves ok with the created Comment', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, liveComment))
    const result = await createComment('t1', 'hello')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/comments')
    expect(options?.method).toBe('POST')
    expect(JSON.parse(options?.body as string)).toEqual({ body: 'hello' })
    expect(result).toEqual({ kind: 'ok', comment: liveComment })
  })

  it('create resolves validation COMMENT_BLANK for a 422 with that code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'COMMENT_BLANK' } }))
    await expect(createComment('t1', '   ')).resolves.toEqual({ kind: 'validation', code: 'COMMENT_BLANK' })
  })

  it('create resolves validation COMMENT_TOO_LONG for a 422 with that code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'COMMENT_TOO_LONG' } }))
    await expect(createComment('t1', 'x'.repeat(6000))).resolves.toEqual({ kind: 'validation', code: 'COMMENT_TOO_LONG' })
  })

  it('create resolves org_missing for a 422 with error.code ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(createComment('t1', 'hi')).resolves.toEqual({ kind: 'org_missing' })
  })

  it('PATCHes /api/tasks/:id/comments/:commentId with body and resolves ok', async () => {
    const edited = { ...liveComment, body: 'edited' }
    h.apiFetch.mockResolvedValue(jsonResponse(200, edited))
    const result = await editComment('t1', 'c1', 'edited')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/comments/c1')
    expect(options?.method).toBe('PATCH')
    expect(JSON.parse(options?.body as string)).toEqual({ body: 'edited' })
    expect(result).toEqual({ kind: 'ok', comment: edited })
  })

  it('edit resolves not_found for a 404 (not the author, or already a tombstone — never distinguished)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(editComment('t1', 'c1', 'edited')).resolves.toEqual({ kind: 'not_found' })
  })

  it('DELETEs /api/tasks/:id/comments/:commentId with no body and resolves ok with the tombstone', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, tombstone))
    const result = await deleteComment('t1', 'c1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/comments/c1')
    expect(options?.method).toBe('DELETE')
    expect(options?.body).toBeUndefined()
    expect(result).toEqual({ kind: 'ok', comment: tombstone })
  })

  it('delete resolves not_found for a 404', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(deleteComment('t1', 'c1')).resolves.toEqual({ kind: 'not_found' })
  })

  it('URI-encodes both the task id and the comment id', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, tombstone))
    await deleteComment('t 1', 'c 1')
    expect(lastCall()[0]).toBe('/api/tasks/t%201/comments/c%201')
  })

  it.each([
    ['deleted true but body not null', () => ({ ...liveComment, deleted: true })],
    ['deleted false but body null', () => ({ ...liveComment, body: null })],
  ])('create resolves error for a malformed 200 body: %s', async (_label, build) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, build()))
    await expect(createComment('t1', 'hi')).resolves.toEqual({ kind: 'error', status: 200 })
  })
})

describe('checkCommentBody (client-side pre-check, mirrors normalizeCommentBody)', () => {
  it('returns ok for an ordinary non-blank comment', () => {
    expect(checkCommentBody('hello world')).toBe('ok')
  })

  it('returns COMMENT_BLANK for an empty string', () => {
    expect(checkCommentBody('')).toBe('COMMENT_BLANK')
  })

  it('returns COMMENT_BLANK for a whitespace-only string', () => {
    expect(checkCommentBody('   \n\t  ')).toBe('COMMENT_BLANK')
  })

  it('returns ok at exactly 5000 code points', () => {
    expect(checkCommentBody('x'.repeat(5000))).toBe('ok')
  })

  it('returns COMMENT_TOO_LONG at 5001 code points', () => {
    expect(checkCommentBody('x'.repeat(5001))).toBe('COMMENT_TOO_LONG')
  })

  it('returns COMMENT_INVALID_CHAR for a U+0000 anywhere, after the blank and length checks (server order)', () => {
    expect(checkCommentBody('a\u0000b')).toBe('COMMENT_INVALID_CHAR')
    expect(checkCommentBody('\u0000')).toBe('COMMENT_INVALID_CHAR')
    expect(checkCommentBody('x'.repeat(5001) + '\u0000')).toBe('COMMENT_TOO_LONG')
    expect(checkCommentBody('   ')).toBe('COMMENT_BLANK')
    expect(checkCommentBody('a\u0001b')).toBe('ok')
  })

  // Measured by UNICODE CODE POINTS, not UTF-16 code units: a surrogate-pair astral character
  // (e.g. an emoji) is ONE code point, so 5000 of them must still read as 'ok' even though
  // `.length` (UTF-16 units) would report 10000.
  it('measures by code points, not UTF-16 code units, for astral-plane characters', () => {
    const astral = '\u{1F600}' // one code point, two UTF-16 code units
    const body = astral.repeat(5000)
    expect(body.length).toBe(10000)
    expect(checkCommentBody(body)).toBe('ok')
    expect(checkCommentBody(astral.repeat(5001))).toBe('COMMENT_TOO_LONG')
  })
})

describe('deleteTask', () => {
  it('DELETEs /api/tasks/:id with no body and resolves ok with deleted: true', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1', deleted: true }))
    const result = await deleteTask('t1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1')
    expect(options?.method).toBe('DELETE')
    expect(options?.body).toBeUndefined()
    expect(result).toEqual({ kind: 'ok', id: 't1', deleted: true })
  })

  it('resolves not_found for a 404 (not_found and forbidden both fold into this per §3.7)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(deleteTask('t1')).resolves.toEqual({ kind: 'not_found' })
  })

  it('resolves conflict HAS_CHILDREN for a 409 with that code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(409, { error: { code: 'HAS_CHILDREN' } }))
    await expect(deleteTask('t1')).resolves.toEqual({ kind: 'conflict', code: 'HAS_CHILDREN' })
  })

  it('resolves error for a 409 with no parseable error.code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(409, {}))
    await expect(deleteTask('t1')).resolves.toEqual({ kind: 'error', status: 409 })
  })

  it('resolves org_missing for a 422 with error.code ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(deleteTask('t1')).resolves.toEqual({ kind: 'org_missing' })
  })

  it.each([
    ['missing id', (b: Record<string, unknown>) => { delete b.id }],
    ['deleted not literally true', (b: Record<string, unknown>) => { b.deleted = false }],
  ])('resolves error for a malformed 200 body: %s', async (_label, corrupt) => {
    const body: Record<string, unknown> = { id: 't1', deleted: true }
    corrupt(body)
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(deleteTask('t1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves error when apiFetch rejects (network failure)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(deleteTask('t1')).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

// ---------------------------------------------------------------------------------------------
// Path-segment safety: an id that is `.` or `..` would be collapsed by URL parsing and reach a
// different route, so every M3 write refuses it before building a request.
// ---------------------------------------------------------------------------------------------

describe('path-segment safety', () => {
  it('isPathSafeSegment rejects empty, "." and "..", and accepts ordinary ids', () => {
    expect(isPathSafeSegment('')).toBe(false)
    expect(isPathSafeSegment('.')).toBe(false)
    expect(isPathSafeSegment('..')).toBe(false)
    expect(isPathSafeSegment('...')).toBe(true)
    expect(isPathSafeSegment('u.1')).toBe(true)
    expect(isPathSafeSegment('%2e%2e')).toBe(true)
  })

  it.each(['.', '..'])('member add/remove with userId %j resolves validation INVALID_ASSIGNEES without any request', async (userId) => {
    await expect(removeAssignee('t1', userId)).resolves.toEqual({ kind: 'validation', code: 'INVALID_ASSIGNEES' })
    await expect(removeFollower('t1', userId)).resolves.toEqual({ kind: 'validation', code: 'INVALID_ASSIGNEES' })
    await expect(addAssignee('t1', userId)).resolves.toEqual({ kind: 'validation', code: 'INVALID_ASSIGNEES' })
    await expect(addFollower('t1', userId)).resolves.toEqual({ kind: 'validation', code: 'INVALID_ASSIGNEES' })
    expect(h.apiFetch).not.toHaveBeenCalled()
  })

  it.each(['.', '..'])('comment edit/delete with commentId %j resolves not_found without any request', async (commentId) => {
    await expect(editComment('t1', commentId, 'x')).resolves.toEqual({ kind: 'not_found' })
    await expect(deleteComment('t1', commentId)).resolves.toEqual({ kind: 'not_found' })
    expect(h.apiFetch).not.toHaveBeenCalled()
  })

  it.each(['.', '..'])('every task-scoped write with task id %j resolves not_found without any request', async (id) => {
    await expect(setParent(id, 'p1')).resolves.toEqual({ kind: 'not_found' })
    await expect(addAssignee(id, 'u1')).resolves.toEqual({ kind: 'not_found' })
    await expect(removeAssignee(id, 'u1')).resolves.toEqual({ kind: 'not_found' })
    await expect(setCompletionMode(id, 'any')).resolves.toEqual({ kind: 'not_found' })
    await expect(addFollower(id, 'u1')).resolves.toEqual({ kind: 'not_found' })
    await expect(removeFollower(id, 'u1')).resolves.toEqual({ kind: 'not_found' })
    await expect(leaveTask(id)).resolves.toEqual({ kind: 'not_found' })
    await expect(createComment(id, 'x')).resolves.toEqual({ kind: 'not_found' })
    await expect(editComment(id, 'c1', 'x')).resolves.toEqual({ kind: 'not_found' })
    await expect(deleteComment(id, 'c1')).resolves.toEqual({ kind: 'not_found' })
    await expect(deleteTask(id)).resolves.toEqual({ kind: 'not_found' })
    expect(h.apiFetch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------
// getTask with the M3 detail fields (contract §3.2).
// ---------------------------------------------------------------------------------------------

describe('getTask — M3 detail fields', () => {
  function m2Body(over: Record<string, unknown> = {}): Record<string, unknown> {
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

  function m3Body(over: Record<string, unknown> = {}): Record<string, unknown> {
    return m2Body({ parentId: null, depth: 0, children: [], ...over })
  }

  const child = { id: 'c1', title: 'Child', status: 'open', completionMode: 'all', depth: 1 }

  it('an M2-shaped body (no tree fields) resolves ok as a root task with no children', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, m2Body()))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'ok', task: m3Body() })
  })

  it('an M3 body with a parent and valid children resolves ok with them', async () => {
    const body = m3Body({ parentId: 'p1', depth: 1, children: [{ ...child, depth: 2 }] })
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'ok', task: body })
  })

  it.each([
    ['only parentId present (partial group)', m2Body({ parentId: null })],
    ['depth and children without parentId (partial group)', m2Body({ depth: 0, children: [] })],
    ['parentId is a number', m3Body({ parentId: 5 })],
    ['depth is a string', m3Body({ depth: 'x' })],
    ['depth is Infinity', m3Body({ depth: Infinity })],
    ['depth is null', m3Body({ depth: null })],
    ['children is not an array', m3Body({ children: 'nope' })],
    ['a child has an unknown status', m3Body({ children: [{ ...child, status: 'weird' }] })],
    ['a child has an unknown completionMode', m3Body({ children: [{ ...child, completionMode: 'some' }] })],
    ['a child has depth null', m3Body({ children: [{ ...child, depth: null }] })],
    ['a child has no id', m3Body({ children: [{ ...child, id: undefined }] })],
    ['a child has no title', m3Body({ children: [{ ...child, title: undefined }] })],
    ['followers is not an array', m3Body({ followers: 'u1' })],
    ['followers carries a non-string', m3Body({ followers: ['u1', 2] })],
    ['canLeave is not a boolean', m3Body({ canLeave: 'yes' })],
    ['canEdit is not a boolean', m3Body({ canEdit: 1 })],
    ['canDelete is not a boolean', m3Body({ canDelete: 'no' })],
    ['canComment is not a boolean', m3Body({ canComment: null })],
  ])('resolves error for a 200 whose body is malformed: %s', async (_label, body) => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('carries optional followers and canLeave through when present and well-formed', async () => {
    const body = m3Body({ followers: ['u5', 'viewer1'], canLeave: true })
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'ok', task: body })
  })

  it('carries the optional row abilities through when present, and leaves them absent otherwise', async () => {
    const body = m3Body({ canEdit: false, canDelete: false, canComment: true })
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'ok', task: body })

    h.apiFetch.mockResolvedValue(jsonResponse(200, m3Body({})))
    const bare = await getTask('t1')
    expect(bare.kind).toBe('ok')
    if (bare.kind !== 'ok') return
    expect('canEdit' in bare.task).toBe(false)
    expect('canDelete' in bare.task).toBe(false)
    expect('canComment' in bare.task).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// checkCommentBody measures the same text the server measures (NFC + edge trim of White_Space and
// zero-width marks), so it never rejects a body the server would accept.
// ---------------------------------------------------------------------------------------------

describe('checkCommentBody — parity with the server normalization', () => {
  it('ignores edge whitespace when measuring length', () => {
    expect(checkCommentBody('a'.repeat(5000) + '\n')).toBe('ok')
    expect(checkCommentBody('   ' + 'a'.repeat(5000))).toBe('ok')
    expect(checkCommentBody('a'.repeat(5001))).toBe('COMMENT_TOO_LONG')
  })

  it('measures NFC code points, so a decomposed accent counts once', () => {
    const decomposed = 'é'.repeat(3000)
    expect(Array.from(decomposed)).toHaveLength(6000)
    expect(checkCommentBody(decomposed)).toBe('ok')
  })

  it('trims zero-width marks at the edges like the server, and treats an only-zero-width body as blank', () => {
    expect(checkCommentBody('​' + 'a'.repeat(5000) + '﻿')).toBe('ok')
    expect(checkCommentBody('​‌‍﻿')).toBe('COMMENT_BLANK')
    expect(checkCommentBody(' 　 ')).toBe('COMMENT_BLANK')
  })
})

// ---------------------------------------------------------------------------------------------
// Every path segment is URI-encoded, in every M3 wrapper.
// ---------------------------------------------------------------------------------------------

describe('path segments are URI-encoded in every M3 wrapper', () => {
  const R = 'a/b?c#d'
  const E = 'a%2Fb%3Fc%23d'
  it.each([
    ['setParent task id', () => setParent(R, 'p1'), `/api/tasks/${E}/parent`],
    ['addAssignee task id', () => addAssignee(R, 'u1'), `/api/tasks/${E}/assignees`],
    ['removeAssignee task id', () => removeAssignee(R, 'u1'), `/api/tasks/${E}/assignees/u1`],
    ['removeAssignee user id', () => removeAssignee('t1', R), `/api/tasks/t1/assignees/${E}`],
    ['setCompletionMode task id', () => setCompletionMode(R, 'any'), `/api/tasks/${E}/completion-mode`],
    ['addFollower task id', () => addFollower(R, 'u1'), `/api/tasks/${E}/followers`],
    ['removeFollower task id', () => removeFollower(R, 'u1'), `/api/tasks/${E}/followers/u1`],
    ['removeFollower user id', () => removeFollower('t1', R), `/api/tasks/t1/followers/${E}`],
    ['leaveTask task id', () => leaveTask(R), `/api/tasks/${E}/leave`],
    ['listComments task id', () => listComments(R), `/api/tasks/${E}/comments?limit=100&offset=0`],
    ['createComment task id', () => createComment(R, 'x'), `/api/tasks/${E}/comments`],
    ['editComment task id', () => editComment(R, 'c1', 'x'), `/api/tasks/${E}/comments/c1`],
    ['editComment comment id', () => editComment('t1', R, 'x'), `/api/tasks/t1/comments/${E}`],
    ['deleteComment task id', () => deleteComment(R, 'c1'), `/api/tasks/${E}/comments/c1`],
    ['deleteComment comment id', () => deleteComment('t1', R), `/api/tasks/t1/comments/${E}`],
    ['deleteTask task id', () => deleteTask(R), `/api/tasks/${E}`],
  ] as const)('%s', async (_label, call, path) => {
    h.apiFetch.mockResolvedValue(jsonResponse(500, {}))
    await call()
    expect(lastCall()[0]).toBe(path)
  })
})
