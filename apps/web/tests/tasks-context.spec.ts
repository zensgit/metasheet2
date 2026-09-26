import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}))

// tasksContext.ts imports `apiFetch` from '../utils/api' — the SAME authenticated fetch helper
// approvals and every other authenticated view use (see apps/web/src/approvals/api.ts,
// apps/web/src/approvals/delegations.ts, …). No bespoke HTTP client is invented here; this mock
// only replaces the transport so the classifier can be driven through every response shape without
// a real network call.
vi.mock('../src/utils/api', () => ({
  apiFetch: h.apiFetch,
}))

import { classifyTasksContext, loadTasksContext } from '../src/tasks/tasksContext'

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response
}

describe('classifyTasksContext (pure classifier)', () => {
  it('classifies a 200 with a string orgId as ready', () => {
    expect(classifyTasksContext(200, { orgId: 'org-1' })).toEqual({ state: 'ready', orgId: 'org-1' })
  })

  it('classifies a 200 with orgId null as org_missing', () => {
    expect(classifyTasksContext(200, { orgId: null })).toEqual({ state: 'org_missing' })
  })

  it('classifies a 200 with no orgId field at all as error (only an explicit null is org_missing)', () => {
    expect(classifyTasksContext(200, {})).toEqual({ state: 'error' })
  })

  it('classifies a 200 with a non-string, non-null orgId as error', () => {
    expect(classifyTasksContext(200, { orgId: 42 })).toEqual({ state: 'error' })
  })

  it('classifies a 200 with a non-object body as error', () => {
    expect(classifyTasksContext(200, null)).toEqual({ state: 'error' })
  })

  it('classifies a 404 as unavailable (no assertion about TASKS_ENABLED)', () => {
    expect(classifyTasksContext(404, null)).toEqual({ state: 'unavailable' })
  })

  it('classifies a 403 as forbidden', () => {
    expect(classifyTasksContext(403, null)).toEqual({ state: 'forbidden' })
  })

  it('classifies a 500 as error', () => {
    expect(classifyTasksContext(500, null)).toEqual({ state: 'error' })
  })
})

describe('loadTasksContext (transport + classification via the shared apiFetch helper)', () => {
  beforeEach(() => {
    h.apiFetch.mockReset()
  })

  it('calls GET /api/tasks/context through apiFetch', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { orgId: 'org-1' }))
    await loadTasksContext()
    expect(h.apiFetch).toHaveBeenCalledWith('/api/tasks/context')
  })

  it('resolves ready for a 200 with a string orgId', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { orgId: 'org-1' }))
    await expect(loadTasksContext()).resolves.toEqual({ state: 'ready', orgId: 'org-1' })
  })

  it('resolves org_missing for a 200 with orgId null', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(200, { orgId: null }))
    await expect(loadTasksContext()).resolves.toEqual({ state: 'org_missing' })
  })

  it('resolves unavailable for a 404', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(404, null))
    await expect(loadTasksContext()).resolves.toEqual({ state: 'unavailable' })
  })

  it('resolves forbidden for a 403', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(403, null))
    await expect(loadTasksContext()).resolves.toEqual({ state: 'forbidden' })
  })

  it('resolves error for a 500', async () => {
    h.apiFetch.mockResolvedValue(jsonResponse(500, null))
    await expect(loadTasksContext()).resolves.toEqual({ state: 'error' })
  })

  it('resolves error when apiFetch rejects (network failure)', async () => {
    h.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(loadTasksContext()).resolves.toEqual({ state: 'error' })
  })

  it('resolves error when a 200 response body fails to parse as JSON', async () => {
    h.apiFetch.mockResolvedValue({
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input')
      },
    } as unknown as Response)
    await expect(loadTasksContext()).resolves.toEqual({ state: 'error' })
  })
})
