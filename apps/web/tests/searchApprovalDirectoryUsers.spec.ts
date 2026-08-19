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

import { searchApprovalDirectoryUsers, resolveApprovalDirectoryUsers, ApprovalDirectoryResolveError } from '../src/approvals/api'

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

// member-display-identity (2026-08-19; tightened 2026-08-19 per owner decision — role resolution
// stays admin-only) — unit coverage for the typed frontend wrapper around the EXACT batch resolve
// endpoint (GET /api/approvals/directory/resolve). UNLIKE searchApprovalDirectoryUsers above, this
// wrapper does NOT degrade failures to [] -- it THROWS (see the P3-3 fix note on the export
// itself), so the caller (directoryResolve.ts) can tell a transient failure apart from a
// confirmed-empty result. Same apiFetch-mocking approach as searchApprovalDirectoryUsers above.
describe('resolveApprovalDirectoryUsers', () => {
  beforeEach(() => { apiFetchMock.mockReset() })
  afterEach(() => { vi.clearAllMocks() })

  it('sends ?userIds=<comma-joined> and maps the bare {users} shape', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))

    const result = await resolveApprovalDirectoryUsers(['u1', 'u2'])

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/directory/resolve?userIds=u1%2Cu2')
    expect(result).toEqual([{ id: 'u1', name: 'Alice' }])
  })

  it('trims and drops blank ids; an all-blank/empty input never calls apiFetch at all', async () => {
    await expect(resolveApprovalDirectoryUsers([])).resolves.toEqual([])
    await expect(resolveApprovalDirectoryUsers(['  ', ''])).resolves.toEqual([])
    expect(apiFetchMock).not.toHaveBeenCalled()

    apiFetchMock.mockResolvedValue(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))
    await resolveApprovalDirectoryUsers(['  u1  ', ''])
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/directory/resolve?userIds=u1')
  })

  it('drops a row with a blank/missing name -- values-free on miss, never padded with an empty name', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ users: [{ id: 'u1', name: '' }, { id: 'u2' }, { id: 'u3', name: 'Bob' }] }),
    )

    const result = await resolveApprovalDirectoryUsers(['u1', 'u2', 'u3'])

    expect(result).toEqual([{ id: 'u3', name: 'Bob' }])
  })

  // P3-3 fix (member-display-identity gate report, 2026-08-19): a non-OK response is a FAILURE the
  // caller (directoryResolve.ts's flushUsers) must be able to distinguish from a confirmed-empty
  // result, so this wrapper now THROWS instead of degrading to []. `status` is carried on the error
  // so the caller can tell 401/403 (terminal) apart from everything else (transient, retryable).
  it('a non-OK response THROWS ApprovalDirectoryResolveError carrying the status (no longer degrades to [])', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({}, { status: 403, ok: false }))
    await expect(resolveApprovalDirectoryUsers(['u1'])).rejects.toMatchObject({
      status: 403,
    })
    await expect(resolveApprovalDirectoryUsers(['u1'])).rejects.toBeInstanceOf(ApprovalDirectoryResolveError)
  })

  it('a network/fetch rejection propagates (no longer degrades to [])', async () => {
    apiFetchMock.mockRejectedValue(new Error('network down'))
    await expect(resolveApprovalDirectoryUsers(['u1'])).rejects.toThrow('network down')
  })

  it('a malformed (non-array `users`) body on an OK response still resolves to [] -- the server DID answer, nothing to retry', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ users: 'nope' }))
    await expect(resolveApprovalDirectoryUsers(['u1'])).resolves.toEqual([])
  })
})

// member-display-identity (2026-08-19) — the shared reactive resolver cache
// (directoryResolve.ts). Drives it through the SAME mocked `apiFetch` this file already
// intercepts (`../src/utils/api`), so this is an integration of cache-batching + the real wire
// format, not a re-implementation with a hand-rolled resolve mock.
describe('directoryResolve (the shared resolver cache)', () => {
  beforeEach(async () => {
    apiFetchMock.mockReset()
    const { __resetResolvedDirectoryNamesForTests } = await import('../src/approvals/directoryResolve')
    __resetResolvedDirectoryNamesForTests()
  })
  afterEach(() => { vi.clearAllMocks() })

  async function flushMicrotasks(cycles = 8): Promise<void> {
    for (let i = 0; i < cycles; i += 1) await Promise.resolve()
  }

  it('getResolvedUserName is null before resolution settles, then the real name once it does', async () => {
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockResolvedValue(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))

    expect(getResolvedUserName('u1')).toBeNull()
    ensureUserNamesResolved(['u1'])
    expect(getResolvedUserName('u1'), 'still unresolved synchronously -- the fetch has not settled yet').toBeNull()

    await flushMicrotasks()
    expect(getResolvedUserName('u1')).toBe('Alice')
  })

  it('an id omitted from the response resolves to null (confirmed-unresolved), not left pending forever', async () => {
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockResolvedValue(jsonResponse({ users: [] })) // e.g. inactive/nonexistent id

    ensureUserNamesResolved(['ghost'])
    await flushMicrotasks()

    expect(getResolvedUserName('ghost')).toBeNull()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    // Re-calling ensure for the SAME id must not re-fetch -- it is already known (confirmed null).
    ensureUserNamesResolved(['ghost'])
    await flushMicrotasks()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it('overlapping ensure calls in the same tick collapse into ONE batched fetch', async () => {
    const { ensureUserNamesResolved } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockResolvedValue(jsonResponse({ users: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }))

    ensureUserNamesResolved(['a'])
    ensureUserNamesResolved(['b'])
    ensureUserNamesResolved(['a', 'b']) // fully overlapping, already pending -- adds nothing new
    await flushMicrotasks()

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/directory/resolve?userIds=a%2Cb')
  })

  it('more than 50 ids are chunked into multiple requests (matches the backend clamp)', async () => {
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockImplementation(async (path: string) => {
      const ids = new URL(path, 'http://x').searchParams.get('userIds')?.split(',') ?? []
      return jsonResponse({ users: ids.map((id) => ({ id, name: `name-${id}` })) })
    })

    const ids = Array.from({ length: 120 }, (_, i) => `u${i}`)
    ensureUserNamesResolved(ids)
    await flushMicrotasks(20)

    expect(apiFetchMock.mock.calls.length).toBeGreaterThanOrEqual(3) // ceil(120/50)
    expect(getResolvedUserName('u0')).toBe('name-u0')
    expect(getResolvedUserName('u119')).toBe('name-u119')
  })

  // P3-3 fix (member-display-identity gate report, 2026-08-19): a rejection never throws out of
  // `ensureUserNamesResolved`/crashes the caller (unchanged from before the fix) -- but the id must
  // stay RETRYABLE, not get cached as a confirmed miss. `getResolvedUserName === null` alone proves
  // nothing here (it is `null` for both "absent" and "cached null" -- see the tri-state doc in
  // directoryResolve.ts), so the load-bearing assertion is the SECOND `apiFetch` call after a fresh
  // `ensure`, contrasted with the confirmed-miss test above (line ~196) which asserts the opposite:
  // exactly one call, never re-fetched.
  it('a TRANSIENT resolve() failure (network rejection) never throws, and leaves the id RETRYABLE -- not cached as a confirmed miss', async () => {
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockRejectedValueOnce(new Error('network down'))

    expect(() => ensureUserNamesResolved(['u1'])).not.toThrow()
    await flushMicrotasks()
    expect(getResolvedUserName('u1'), 'unresolved after a failure -- rendering must still fall back to a placeholder').toBeNull()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    // Retry: a fresh `ensure` call for the SAME id after a transient failure MUST re-fetch --
    // unlike the confirmed-miss case, where the sibling test above proves it does NOT.
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))
    ensureUserNamesResolved(['u1'])
    await flushMicrotasks()
    expect(apiFetchMock, 'a transient failure must not permanently disable retry for this id').toHaveBeenCalledTimes(2)
    expect(getResolvedUserName('u1')).toBe('Alice')
  })

  // A 5xx (non-OK, but not 401/403) is transient the same way a network throw is -- same retry
  // contract, different failure shape (this wrapper throws ApprovalDirectoryResolveError for it,
  // not a bare rejection).
  it('a TRANSIENT resolve() failure (500 response) also leaves the id RETRYABLE', async () => {
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 500, ok: false }))

    ensureUserNamesResolved(['u1'])
    await flushMicrotasks()
    expect(getResolvedUserName('u1')).toBeNull()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    apiFetchMock.mockResolvedValueOnce(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))
    ensureUserNamesResolved(['u1'])
    await flushMicrotasks()
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(getResolvedUserName('u1')).toBe('Alice')
  })

  // A TERMINAL failure (401/403 -- the caller structurally lacks approvals:read|write|act, or the
  // session is gone) is the ONE failure mode that still caches `null` -- retrying cannot succeed,
  // so it degrades exactly like a confirmed miss (matches the pre-P3-3 contract for this one case).
  it('a TERMINAL resolve() failure (403) IS cached as a confirmed miss -- no retry, matches the pre-fix contract for this case', async () => {
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 403, ok: false }))

    ensureUserNamesResolved(['u1'])
    await flushMicrotasks()
    expect(getResolvedUserName('u1')).toBeNull()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    apiFetchMock.mockResolvedValueOnce(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))
    ensureUserNamesResolved(['u1'])
    await flushMicrotasks()
    expect(apiFetchMock, '403 is terminal -- must NOT re-fetch').toHaveBeenCalledTimes(1)
    expect(getResolvedUserName('u1')).toBeNull()
  })

  it('joinIfAllResolved: joined names only when EVERY id resolves, null on any miss, [] for an empty list', async () => {
    const { ensureUserNamesResolved, getResolvedUserName, joinIfAllResolved } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockResolvedValue(jsonResponse({ users: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }))
    ensureUserNamesResolved(['a', 'b', 'c'])
    await flushMicrotasks()

    expect(joinIfAllResolved(['a', 'b'], getResolvedUserName)).toEqual(['A', 'B'])
    expect(joinIfAllResolved(['a', 'c'], getResolvedUserName), 'c never resolved -> null, not a partial list').toBeNull()
    expect(joinIfAllResolved([], getResolvedUserName)).toEqual([])
  })

  it('__resetResolvedDirectoryNamesForTests clears the cache -- a previously-resolved id re-fetches', async () => {
    const mod = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockResolvedValue(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))

    mod.ensureUserNamesResolved(['u1'])
    await flushMicrotasks()
    expect(mod.getResolvedUserName('u1')).toBe('Alice')

    mod.__resetResolvedDirectoryNamesForTests()
    expect(mod.getResolvedUserName('u1'), 'cleared -> unresolved again until re-ensured').toBeNull()

    apiFetchMock.mockClear()
    mod.ensureUserNamesResolved(['u1'])
    await flushMicrotasks()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(mod.getResolvedUserName('u1')).toBe('Alice')
  })
})
