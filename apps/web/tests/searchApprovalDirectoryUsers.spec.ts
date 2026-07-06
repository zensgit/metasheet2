import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// B3-04 D-2 — unit coverage for the typed frontend wrapper around the D-1 participant directory
// endpoint (GET /api/approvals/directory/users, #3664). Modeled on useApprovalDirectory.spec.ts's
// coverage of the sibling AUTHOR-picker composable, but this function is deliberately UNGATED by
// USE_MOCK (see the comment in approvals/api.ts) so it always exercises the real apiFetch path —
// unlike most of that file's exports, which approvalApiErrorSurfacing.spec.ts notes always take
// their mock branch under Vitest (import.meta.env.DEV is true). Mocks `../src/utils/api`'s
// `apiFetch` directly, which is safe: every OTHER function in approvals/api.ts stays on its
// USE_MOCK branch under Vitest and never reaches apiFetch, so this mock cannot affect them.
const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import { searchApprovalDirectoryUsers } from '../src/approvals/api'

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response
}

describe('searchApprovalDirectoryUsers', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('200 → maps the bare {users} shape to ApprovalDirectoryUser[]', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ users: [{ id: 'u1', name: 'Alice', email: 'a@x.io' }] }),
    )

    const result = await searchApprovalDirectoryUsers('ali')

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/directory/users?q=ali&limit=20')
    expect(result).toEqual([{ id: 'u1', name: 'Alice', email: 'a@x.io' }])
  })

  it('trims the query, omits `q` when blank, and always sends `limit`', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ users: [] }))

    await searchApprovalDirectoryUsers('  ')

    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/directory/users?limit=20')
  })

  it('honors a custom limit', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ users: [] }))

    await searchApprovalDirectoryUsers('bob', 5)

    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/directory/users?q=bob&limit=5')
  })

  it('drops malformed entries (no id) and coerces missing name/email', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        users: [{ id: 'u1' }, { name: 'no-id' }, null, { id: 'u2', name: 'Bob', email: 'b@x.io' }],
      }),
    )

    const result = await searchApprovalDirectoryUsers('x')

    expect(result).toEqual([
      { id: 'u1', name: '', email: '' },
      { id: 'u2', name: 'Bob', email: 'b@x.io' },
    ])
  })

  it('a non-OK response resolves to [] (never throws)', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ error: 'forbidden' }, { status: 403, ok: false }))

    await expect(searchApprovalDirectoryUsers('x')).resolves.toEqual([])
  })

  it('a malformed (non-array `users`) body resolves to []', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ users: 'not-an-array' }))

    await expect(searchApprovalDirectoryUsers('x')).resolves.toEqual([])
  })

  it('a JSON-parse failure resolves to []', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('Unexpected token') },
    } as unknown as Response)

    await expect(searchApprovalDirectoryUsers('x')).resolves.toEqual([])
  })

  it('a network/fetch rejection resolves to [] (never throws)', async () => {
    apiFetchMock.mockRejectedValue(new Error('network down'))

    await expect(searchApprovalDirectoryUsers('x')).resolves.toEqual([])
  })
})
