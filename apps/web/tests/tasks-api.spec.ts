import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}))

// Same authenticated transport every other view uses (see tasks-context.spec.ts's identical note).
// Only the transport is replaced so every response shape can be driven without a real network call.
vi.mock('../src/utils/api', () => ({
  apiFetch: h.apiFetch,
}))

import {
  completeTask,
  createTask,
  fetchPendingCount,
  getTask,
  listTasks,
  reopenTask,
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

describe('listTasks', () => {
  it('requests the given view and resolves ok with items', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [{ id: 't1', title: 'x', status: 'open', completion_mode: 'all', created_by: 'u1', due_at: null }] }))
    const result = await listTasks('assigned')
    expect(lastCall()[0]).toBe('/api/tasks?view=assigned')
    expect(result).toEqual({
      kind: 'ok',
      items: [{ id: 't1', title: 'x', status: 'open', completion_mode: 'all', created_by: 'u1', due_at: null }],
    })
  })

  it('resolves ok with an empty items array on a genuinely empty 200 (empty is not an error)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [] }))
    await expect(listTasks('following')).resolves.toEqual({ kind: 'ok', items: [] })
  })

  it('resolves org_missing for a degraded 200 with reason org_missing', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    await expect(listTasks('created')).resolves.toEqual({ kind: 'org_missing' })
  })

  it('resolves predicate_error (NOT org_missing) for a degraded 200 with reason predicate_error', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'predicate_error' }))
    await expect(listTasks('delegated')).resolves.toEqual({ kind: 'predicate_error' })
  })

  it('resolves error for a degraded 200 with an unrecognized reason', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: [], degraded: true, reason: 'something_else' }))
    await expect(listTasks('any_role')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves forbidden for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(listTasks('assigned')).resolves.toEqual({ kind: 'forbidden' })
  })

  it('resolves not_found for a 404', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(listTasks('assigned')).resolves.toEqual({ kind: 'not_found' })
  })

  it('resolves error for a 500', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(500, null))
    await expect(listTasks('assigned')).resolves.toEqual({ kind: 'error', status: 500 })
  })

  it('resolves error for a malformed 200 (items is not an array)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { items: 'nope' }))
    await expect(listTasks('assigned')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves error when apiFetch rejects (network failure)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(listTasks('assigned')).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

describe('getTask', () => {
  function fullTaskBody(over: Record<string, unknown> = {}): Record<string, unknown> {
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

  it('requests GET /api/tasks/:id (URI-encoded) and resolves ok with the full camelCase task', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, fullTaskBody({ id: 't 1' })))
    const result = await getTask('t 1')
    expect(lastCall()[0]).toBe('/api/tasks/t%201')
    expect(result).toEqual({ kind: 'ok', task: fullTaskBody({ id: 't 1' }) })
  })

  it('resolves ok with a populated assignees array, each carrying userId and completedAt', async () => {
    const body = fullTaskBody({
      assignees: [
        { userId: 'u1', completedAt: '2026-09-20T10:00:00Z' },
        { userId: 'u2', completedAt: null },
      ],
    })
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'ok', task: body })
  })

  it('resolves forbidden for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'forbidden' })
  })

  // Per the backend contract, a missing task, an invisible one and one in another org are ALL a
  // plain 404 — deliberately never distinguished — so this is the ONLY not-found trigger.
  it('resolves not_found for a 404', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(getTask('missing')).resolves.toEqual({ kind: 'not_found' })
  })

  it('resolves error for a 500', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(500, null))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'error', status: 500 })
  })

  // A single-task READ has no org-guidance trigger — unlike listTasks/createTask/completeTask/
  // reopenTask, this endpoint has no 'org_missing' kind at all (see GetTaskResult's docblock).
  it('has no org_missing kind: even a 422 with error.code ORG_MISSING resolves as a plain error', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    const result = await getTask('t1')
    expect(result).toEqual({ kind: 'error', status: 422 })
    expect(result.kind).not.toBe('org_missing')
  })

  it.each([
    ['missing id', (b: Record<string, unknown>) => { delete b.id }],
    ['missing title', (b: Record<string, unknown>) => { delete b.title }],
    ['bad status literal', (b: Record<string, unknown>) => { b.status = 'closed' }],
    ['bad completionMode literal', (b: Record<string, unknown>) => { b.completionMode = 'some' }],
    ['missing createdBy', (b: Record<string, unknown>) => { delete b.createdBy }],
    ['dueAt wrong type', (b: Record<string, unknown>) => { b.dueAt = 123 }],
    ['dueDate wrong type', (b: Record<string, unknown>) => { b.dueDate = 123 }],
    ['dueTime wrong type', (b: Record<string, unknown>) => { b.dueTime = 123 }],
    ['timeZone wrong type', (b: Record<string, unknown>) => { b.timeZone = 123 }],
    ['assignees not an array', (b: Record<string, unknown>) => { b.assignees = {} }],
    ['assignee missing userId', (b: Record<string, unknown>) => { b.assignees = [{ completedAt: null }] }],
    ['assignee completedAt wrong type', (b: Record<string, unknown>) => { b.assignees = [{ userId: 'u1', completedAt: 1 }] }],
    ['canComplete wrong type', (b: Record<string, unknown>) => { b.canComplete = 'yes' }],
    ['canReopen wrong type', (b: Record<string, unknown>) => { b.canReopen = 'no' }],
  ])('resolves error for a malformed 200 body: %s', async (_label, corrupt) => {
    const body = fullTaskBody()
    corrupt(body)
    h.apiFetch.mockResolvedValue(jsonResponse(200, body))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves error when apiFetch rejects (network failure)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(getTask('t1')).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

describe('createTask', () => {
  it('sends title only when assignees/completionMode are omitted — no assignees key at all', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1', title: 'x', status: 'open', completion_mode: 'all', created_by: 'u1', due_at: null }))
    await createTask({ title: 'x' })
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks')
    expect(options?.method).toBe('POST')
    const body = JSON.parse(options?.body as string)
    expect(body).toEqual({ title: 'x' })
    expect('assignees' in body).toBe(false)
  })

  it('sends an explicit empty assignees array as-is (zero assignees, NOT the same as omitting it)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, {}))
    await createTask({ title: 'x', assignees: [] })
    const body = JSON.parse(lastCall()[1]?.body as string)
    expect(body).toEqual({ title: 'x', assignees: [] })
  })

  it('sends explicit assignees and camelCase completionMode', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, {}))
    await createTask({ title: 'x', assignees: ['u1', 'u2'], completionMode: 'any' })
    const body = JSON.parse(lastCall()[1]?.body as string)
    expect(body).toEqual({ title: 'x', assignees: ['u1', 'u2'], completionMode: 'any' })
  })

  it('resolves ok with the created id on 200 (the backend does NOT echo the full row)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { id: 't1' }))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'ok', id: 't1' })
  })

  it('resolves error for a 200 with no string id (a malformed body must not masquerade as ok)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, {}))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves org_missing for a 422 with error.code ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'org_missing' })
  })

  it('resolves error (NOT org_missing) for a 422 with a different error code', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'VALIDATION_FAILED' } }))
    await expect(createTask({ title: '' })).resolves.toEqual({ kind: 'error', status: 422 })
  })

  it('resolves forbidden for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'forbidden' })
  })

  it('resolves not_found for a 404', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'not_found' })
  })

  it('resolves error when apiFetch rejects (network failure)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(createTask({ title: 'x' })).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

describe('completeTask', () => {
  it('POSTs to /api/tasks/:id/complete and resolves ok with done', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { done: true }))
    const result = await completeTask('t1')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/complete')
    expect(options?.method).toBe('POST')
    expect(result).toEqual({ kind: 'ok', done: true })
  })

  it('resolves ok with done:false when not every required completion has landed yet', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { done: false }))
    await expect(completeTask('t1')).resolves.toEqual({ kind: 'ok', done: false })
  })

  it('resolves org_missing for a 422 ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(completeTask('t1')).resolves.toEqual({ kind: 'org_missing' })
  })

  // P2-3: a 403 must map to 'forbidden', NEVER 'org_missing' — the org-guidance UI has exactly
  // three legitimate triggers (see this file's module docblock) and a bare permission denial is
  // not one of them.
  it('resolves forbidden (NOT org_missing) for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(completeTask('t1')).resolves.toEqual({ kind: 'forbidden' })
  })

  it('resolves error (NOT org_missing) for a 422 with a code other than ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'VALIDATION_FAILED' } }))
    await expect(completeTask('t1')).resolves.toEqual({ kind: 'error', status: 422 })
  })

  it('resolves not_found for a 404 (caller has no row role)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(completeTask('t1')).resolves.toEqual({ kind: 'not_found' })
  })

  it('resolves error for a malformed 200 (no boolean done)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, {}))
    await expect(completeTask('t1')).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves error when apiFetch rejects (network failure)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(completeTask('t1')).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

describe('reopenTask', () => {
  it('POSTs scope in the body and resolves ok', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { ok: true }))
    const result = await reopenTask('t1', 'self')
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/t1/reopen')
    expect(options?.method).toBe('POST')
    expect(JSON.parse(options?.body as string)).toEqual({ scope: 'self' })
    expect(result).toEqual({ kind: 'ok' })
  })

  it('resolves org_missing for a 422 ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    await expect(reopenTask('t1', 'self')).resolves.toEqual({ kind: 'org_missing' })
  })

  // P2-3, same guard as completeTask above.
  it('resolves forbidden (NOT org_missing) for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(reopenTask('t1', 'self')).resolves.toEqual({ kind: 'forbidden' })
  })

  it('resolves error (NOT org_missing) for a 422 with a code other than ORG_MISSING', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(422, { error: { code: 'VALIDATION_FAILED' } }))
    await expect(reopenTask('t1', 'self')).resolves.toEqual({ kind: 'error', status: 422 })
  })

  it('resolves not_found for a 404', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(reopenTask('t1', 'self')).resolves.toEqual({ kind: 'not_found' })
  })

  it('resolves error when apiFetch rejects (network failure)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(reopenTask('t1', 'self')).resolves.toEqual({ kind: 'error', status: 0 })
  })
})

describe('fetchPendingCount', () => {
  const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions

  afterEach(() => {
    Intl.DateTimeFormat.prototype.resolvedOptions = originalResolvedOptions
  })

  it('sends the viewer time zone header from Intl.DateTimeFormat, not a hardcoded value', async () => {
    Intl.DateTimeFormat.prototype.resolvedOptions = () => ({ timeZone: 'Pacific/Kiritimati' }) as Intl.ResolvedDateTimeFormatOptions
    h.apiFetch.mockResolvedValue(jsonResponse(200, { count: 3 }))
    await fetchPendingCount()
    const [path, options] = lastCall()
    expect(path).toBe('/api/tasks/pending-count')
    expect((options?.headers as Record<string, string>)['x-viewer-time-zone']).toBe('Pacific/Kiritimati')
  })

  it('resolves ok with the count on a plain 200', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { count: 5 }))
    await expect(fetchPendingCount()).resolves.toEqual({ kind: 'ok', count: 5 })
  })

  it('resolves ok with count 0 (a real, trustworthy zero, not "unavailable")', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { count: 0 }))
    await expect(fetchPendingCount()).resolves.toEqual({ kind: 'ok', count: 0 })
  })

  it('resolves org_missing for a degraded 200 with reason org_missing', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { count: 0, degraded: true, reason: 'org_missing' }))
    await expect(fetchPendingCount()).resolves.toEqual({ kind: 'org_missing' })
  })

  // P3: an unrecognized degraded reason must never collapse into a trustworthy 0 — the badge
  // would otherwise render "nothing pending" for what is actually an unknown failure mode.
  it('resolves error (NEVER a count) for a degraded 200 with an unrecognized reason', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { count: 0, degraded: true, reason: 'something_else' }))
    const result = await fetchPendingCount()
    expect(result).toEqual({ kind: 'error', status: 200 })
    expect(result.kind).not.toBe('ok')
  })

  it('resolves forbidden for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(fetchPendingCount()).resolves.toEqual({ kind: 'forbidden' })
  })

  // P3: this is a background nav-badge poll, not a page the viewer navigated to on purpose — a
  // stale session must degrade the badge to 'unavailable', not bounce the viewer to /login.
  it('passes suppressUnauthorizedRedirect so a 401 degrades to unavailable instead of redirecting', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(401, null))
    await fetchPendingCount()
    const [, options] = lastCall()
    expect(options?.suppressUnauthorizedRedirect).toBe(true)
  })

  it('resolves not_found for a 404', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(fetchPendingCount()).resolves.toEqual({ kind: 'not_found' })
  })

  it('resolves error for a malformed 200 (negative count)', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { count: -1 }))
    await expect(fetchPendingCount()).resolves.toEqual({ kind: 'error', status: 200 })
  })

  it('resolves error when apiFetch rejects (network failure)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(fetchPendingCount()).resolves.toEqual({ kind: 'error', status: 0 })
  })
})
