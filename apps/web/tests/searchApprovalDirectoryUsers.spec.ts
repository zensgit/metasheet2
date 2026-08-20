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
  // BACKOFF fix (2026-08-21, Codex #4 P3): unconditional -- harmless when a test never switched
  // to fake timers, and required for the retry-backoff tests below that do, so a real-timer test
  // later in this file never inherits a fake-timer clock left switched on.
  afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

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

  // P3-3 fix (member-display-identity gate report, 2026-08-19; retry redesign 2026-08-19): a
  // rejection never throws out of `ensureUserNamesResolved`/crashes the caller, and the id must
  // stay RETRYABLE, not get cached as a confirmed miss. The gate finding was that NOTHING on the
  // consuming pages ever re-triggers `ensureUserNamesResolved` after a blip (no poller, no
  // render-driven retry) -- so retryability alone is not enough; the retry must happen WITHOUT any
  // second `ensure` call. This is the load-bearing proof: ONE `ensureUserNamesResolved` call, a
  // mock that fails once then recovers, and the name resolves anyway.
  it('a TRANSIENT resolve() failure (network rejection) is retried IN PLACE after the backoff delay and recovers WITHOUT a second ensure call', async () => {
    vi.useFakeTimers()
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockRejectedValueOnce(new Error('network down'))
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))

    expect(() => ensureUserNamesResolved(['u1'])).not.toThrow()
    // Attempt 1 fires on the microtask-debounced flush and fails; the module then awaits the
    // first backoff delay (300ms) before attempt 2 -- advance the fake clock past it. `Async`
    // flushes the microtask queue between/after each timer tick, so this also carries attempt 2
    // (and its extra `await response.json()` hop) through to completion.
    await vi.advanceTimersByTimeAsync(300)

    expect(apiFetchMock, 'the bounded in-place retry must have made a second attempt on its own, after the backoff delay -- no manual re-ensure call above').toHaveBeenCalledTimes(2)
    expect(getResolvedUserName('u1')).toBe('Alice')
  })

  // BACKOFF fix (2026-08-21, Codex #4 P3): the strongest form of the recovery proof -- BOTH of
  // the first two attempts fail, and the id still resolves automatically on attempt 3, entirely
  // within the bounded backoff window (300ms + 1200ms), with no manual second `ensure` call.
  it('a failure that persists through attempts 1 AND 2 still recovers automatically on attempt 3, entirely within the bounded backoff window', async () => {
    vi.useFakeTimers()
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockRejectedValueOnce(new Error('down 1'))
    apiFetchMock.mockRejectedValueOnce(new Error('down 2'))
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))

    ensureUserNamesResolved(['u1'])
    await vi.advanceTimersByTimeAsync(300) // attempt 1 fails, backoff, attempt 2 fires and fails
    expect(getResolvedUserName('u1'), 'still unresolved -- only 2 of 3 attempts have run').toBeNull()
    expect(apiFetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1200) // second backoff, attempt 3 fires and succeeds
    expect(apiFetchMock, 'automatic recovery on the 3rd in-place attempt -- no second ensure call anywhere in this test').toHaveBeenCalledTimes(3)
    expect(getResolvedUserName('u1')).toBe('Alice')
  })

  // A 5xx (non-OK, but not 401/403) is transient the same way a network throw is -- same retry
  // contract, different failure shape (this wrapper throws ApprovalDirectoryResolveError for it,
  // not a bare rejection). This test proves the OTHER half of the contract: the in-place retry is
  // BOUNDED (not an infinite loop against a persistently-failing endpoint) even across the
  // backoff delays, and a failure that outlasts the bound still leaves the id RETRYABLE (not a
  // confirmed miss) for a LATER `ensure` call -- permanent failure stays fail-closed.
  it('a TRANSIENT resolve() failure (500) that persists past the retry bound (across both backoff delays) leaves the id RETRYABLE for a LATER ensure call', async () => {
    vi.useFakeTimers()
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockResolvedValue(jsonResponse({}, { status: 500, ok: false })) // every attempt fails

    ensureUserNamesResolved(['u1'])
    // Advance past BOTH backoff delays (300ms then 1200ms) so all 3 bounded attempts complete.
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(1200)

    expect(getResolvedUserName('u1'), 'unresolved after every retry attempt fails -- rendering must still fall back to a placeholder').toBeNull()
    // 3 == RESOLVE_MAX_ATTEMPTS (directoryResolve.ts, not exported -- pinned here by count so a
    // change to the bound is a deliberate, visible edit to this assertion).
    expect(apiFetchMock, 'bounded -- exactly the retry-attempt cap for ONE ensure call, not unbounded').toHaveBeenCalledTimes(3)

    // A fresh `ensure` call later (e.g. the user re-fetching detail/history) still retries --
    // unlike the confirmed-miss case (sibling test above), where re-ensuring does NOT re-fetch.
    // Real timers from here: attempt 1 of a fresh call never pays the backoff delay.
    vi.useRealTimers()
    apiFetchMock.mockReset()
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))
    ensureUserNamesResolved(['u1'])
    await flushMicrotasks()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
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

  // BACKOFF fix (2026-08-21, Codex #4 P3), cross-test timer-leak proof: the exact objection the
  // pre-fix module comment raised against a real-timer retry -- a backoff timer left pending past
  // one test's own boundary would fire during a LATER, unrelated test and silently inflate ITS
  // apiFetch call count. Leaves a retry's backoff timer PENDING (never advances the clock far
  // enough to fire it), calls the SAME reset every consuming spec's beforeEach already calls, then
  // proves no call ever lands: the clock is advanced well past where the cancelled timer would
  // have fired, in a FRESH fake-timers scope, with a mock that would raise the count if it fired.
  it('__resetResolvedDirectoryNamesForTests cancels a PENDING backoff timer -- it never fires into a later test', async () => {
    vi.useFakeTimers()
    const mod = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockRejectedValue(new Error('down'))

    mod.ensureUserNamesResolved(['u1'])
    await vi.advanceTimersByTimeAsync(0) // let attempt 1 fail and schedule the 300ms backoff timer
    expect(apiFetchMock, 'attempt 1 must have run before the timer this test is about to cancel gets scheduled').toHaveBeenCalledTimes(1)

    // Reset WHILE the 300ms backoff timer is still pending -- this is the cancellation under test.
    mod.__resetResolvedDirectoryNamesForTests()

    // Advance well past where attempt 2 would have fired if the timer had survived the reset.
    await vi.advanceTimersByTimeAsync(5000)
    expect(apiFetchMock, 'the cancelled backoff timer must never fire -- a surviving timer would have added a 2nd (or more) call here').toHaveBeenCalledTimes(1)
    expect(mod.getResolvedUserName('u1'), 'reset also clears the cache -- nothing resolved from the abandoned attempt').toBeNull()
  })

  // In-flight dedup (2026-08-21, Codex #4 P3 gate finding, post-backoff): the backoff delays
  // widen the window during which an id is mid-retry from microtask-short to ~1.5s worst case --
  // long enough that an ordinary second `ensureUserNamesResolved` call for the SAME id (a
  // keystroke, a route change) lands inside it routinely, and does so specifically DURING the
  // outage the retry exists for. Without in-flight tracking this would start a SECOND, independent
  // 3-attempt retry chain for the same id -- 6 requests instead of 3, doubling load against a
  // server that is already struggling. This is the discriminating construction: fire `ensure`,
  // advance PART way into the backoff window (attempt 1 has failed, attempt 2 has not yet fired),
  // fire `ensure` AGAIN for the same id, then let everything settle -- exactly 3 calls, never 6.
  it('a second ensure() call for the SAME id DURING the backoff window does not start a duplicate retry chain (3 calls, not 6)', async () => {
    vi.useFakeTimers()
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockResolvedValue(jsonResponse({}, { status: 500, ok: false })) // every attempt fails

    ensureUserNamesResolved(['u1'])
    await vi.advanceTimersByTimeAsync(150) // attempt 1 done and failed; mid-backoff BEFORE attempt 2 fires (fires at 300ms)
    expect(apiFetchMock, 'sanity: exactly one attempt has run so far').toHaveBeenCalledTimes(1)

    ensureUserNamesResolved(['u1']) // a route change / keystroke during the SAME outage
    await vi.advanceTimersByTimeAsync(3000) // let the in-flight chain's remaining attempts settle

    expect(apiFetchMock, 'a duplicate retry chain would show 6 calls here -- the in-flight id must be a no-op for the second ensure() call').toHaveBeenCalledTimes(3)
    expect(getResolvedUserName('u1'), 'permanent failure still stays fail-closed, and still retryable by a LATER ensure once this chain has concluded').toBeNull()

    // AFTER the chain concludes (this test's own advance above ran it to exhaustion), a FRESH
    // ensure call for the same id must still retry -- in-flight dedup must not become permanent.
    apiFetchMock.mockReset()
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ users: [{ id: 'u1', name: 'Alice' }] }))
    ensureUserNamesResolved(['u1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(getResolvedUserName('u1')).toBe('Alice')
  })

  // In-flight dedup, >50-id case (2026-08-21, gate follow-up on the fix above): an earlier
  // revision of `inFlightUserIds` marked/cleared PER GROUP (per RESOLVE_CHUNK-sized chunk) rather
  // than for the whole flush -- which reopened the exact gap the fix above closes, just shifted
  // from cross-CALL to cross-GROUP: while group 1 (ids 0..49) is mid-backoff, every id in group 2
  // (ids 50+) was in NEITHER `resolvedUserNames` NOR `pendingUserIds` NOR (with the per-group
  // bug) `inFlightUserIds`, so a second `ensureUserNamesResolved` call for a group-2 id during
  // group 1's retry sequence would start its own duplicate chain for that id. Discriminating
  // construction: 60 ids (2 chunks of RESOLVE_CHUNK=50), touch a GROUP-2 id again while GROUP-1
  // is still mid-backoff -- clean is exactly 6 total calls (3 per group); a surviving per-group
  // gap would show more.
  it('a >50-id flush: touching a GROUP-2 id again while GROUP-1 is still mid-backoff does not double-fetch it (6 calls total, not more)', async () => {
    vi.useFakeTimers()
    const { ensureUserNamesResolved, getResolvedUserName } = await import('../src/approvals/directoryResolve')
    apiFetchMock.mockImplementation(async () => jsonResponse({}, { status: 500, ok: false }))

    const ids = Array.from({ length: 60 }, (_, i) => `u${i}`) // group 1 = u0..u49, group 2 = u50..u59
    ensureUserNamesResolved(ids)
    await vi.advanceTimersByTimeAsync(150) // group 1's attempt 1 done+failed; mid-backoff before its attempt 2
    ensureUserNamesResolved(['u55']) // a GROUP-2 id, touched again WHILE group 1 is still retrying
    await vi.advanceTimersByTimeAsync(5000) // let both groups' retry sequences fully settle

    expect(apiFetchMock, '3 attempts for group 1 + 3 for group 2 = 6; a surviving per-group gap would double-fetch u55').toHaveBeenCalledTimes(6)
    expect(getResolvedUserName('u55'), 'permanent failure stays fail-closed').toBeNull()
  })
})
