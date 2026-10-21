import { describe, expect, it, vi } from 'vitest'
import {
  clearFormDraftServer,
  listFormDraftsServer,
  loadFormDraftServer,
  saveFormDraftServer,
  type ServerFormDraftFetcher,
} from '../src/approvals/serverFormDraft'

/**
 * FIX 3 (gate P2-3) — `apps/web/src/approvals/serverFormDraft.ts` is the module that ACTUALLY runs
 * on the production path after P3-3 (`ApprovalNewView.vue:678` imports it), but it shipped with
 * ZERO dedicated tests: the gate broke all four contract §1 semantics simultaneously (drift guard,
 * empty-data-deletes, save-never-throws, load-never-throws) and the full `apps/web` suite was
 * unchanged to the digit (31 failed / 11372 passed / 822 files / 12 errors, before and after).
 * `apps/web/tests/approvalNewView.spec.ts` mocks this entire module out (`vi.mock(...)`), which is
 * legitimate for isolating the VIEW's own logic, but it means nothing anywhere exercises this
 * module's own code.
 *
 * This file drives each of the four exported functions directly via their injected `fetcher`
 * parameter (no Vue, no DOM, no network) — the module was already designed for this (every export
 * takes an optional `fetcher: ServerFormDraftFetcher = apiFetch`). Each semantic below has a
 * POSITIVE CONTROL alongside its negative case, and each is proven load-bearing by mutation (see
 * the fix's own report: one semantic broken at a time, restored, `cmp`-verified) — not "all four
 * simultaneously" the way the gate's own probe (deliberately) did.
 */

// Gate2 P3-C: statuses 204/205/304 are "null body" statuses per the Fetch spec — the Response
// constructor THROWS a TypeError if given a non-null body alongside one of these
// (`new Response('{}', { status: 204 })` throws "Response constructor: Invalid response status
// code 204"). Every call site below that passes `status: 204` is standing in for a real DELETE/PUT
// response with no content, so it must build a genuinely null-body Response — otherwise the
// "fetcher" these tests hand to the module under test is a fetcher that ALWAYS THROWS, and any
// test that swallows that throw is (silently) testing the swallow of this helper's own bug, not
// the module's real handling of a successful no-content response.
const NULL_BODY_STATUSES = new Set([204, 205, 304])

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const status = init.status ?? (init.ok === false ? 500 : 200)
  return new Response(NULL_BODY_STATUSES.has(status) ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('serverFormDraft.ts — drift guard (contract §1 "signature mismatch -> null + best-effort GC")', () => {
  it('POSITIVE: a MATCHING signature returns the draft data, and issues NO delete (nothing to garbage-collect)', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () =>
      jsonResponse({ data: { draft: { templateId: 'tpl_1', signature: 'sig-A', data: { amount: 12 }, savedAt: '2026-01-01T00:00:00.000Z' } } }),
    )
    const result = await loadFormDraftServer('tpl_1', 'sig-A', fetcher)
    expect(result).toEqual({ amount: 12 })
    // Exactly one call (the GET) — no follow-up DELETE for a matching draft.
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.method).not.toBe('DELETE')
  })

  it('NEGATIVE: a MISMATCHED signature returns null AND fires a best-effort DELETE to garbage-collect the stale draft', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async (path, init) => {
      if (init?.method === 'DELETE') return jsonResponse({}, { status: 204 })
      return jsonResponse({ data: { draft: { templateId: 'tpl_1', signature: 'sig-OLD', data: { amount: 12 }, savedAt: '2026-01-01T00:00:00.000Z' } } })
    })
    const result = await loadFormDraftServer('tpl_1', 'sig-CURRENT', fetcher)
    expect(result).toBeNull()
    // Allow the fire-and-forget GC promise to settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const deleteCalls = fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0][0]).toBe('/api/approvals/form-drafts/tpl_1')
  })

  // Gate2 P3-F: `loadFormDraftServer`'s guard collapsed six raw `||` terms onto `isPlainObject`,
  // used at two call sites (`draft` and `draft.data`) plus the GC gate. The two tests below give
  // each of THOSE remaining checks something to lose against — a matching signature is not enough
  // if `draft.data` is not a genuine record, and a response with no real draft object at all must
  // not trigger a wasted GC delete.
  it('MALFORMED: a MATCHING signature but a non-object `data` (an array, not a record) is treated as invalid — returns null and still fires the best-effort GC delete', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async (path, init) => {
      if (init?.method === 'DELETE') return jsonResponse({}, { status: 204 })
      return jsonResponse({ data: { draft: { templateId: 'tpl_1', signature: 'sig-A', data: ['not', 'a', 'record'], savedAt: '2026-01-01T00:00:00.000Z' } } })
    })
    const result = await loadFormDraftServer('tpl_1', 'sig-A', fetcher)
    expect(result).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const deleteCalls = fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')
    expect(deleteCalls).toHaveLength(1)
  })

  it('NO-DRAFT: a response reporting no draft at all (`draft: null`) returns null and does NOT fire a spurious GC delete (nothing was there to clean up)', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => jsonResponse({ data: { draft: null } }))
    const result = await loadFormDraftServer('tpl_1', 'sig-A', fetcher)
    expect(result).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetcher).toHaveBeenCalledTimes(1) // the GET only -- no follow-up DELETE
  })

  // Both this test and NO-DRAFT above exercise the GC GATE's `isPlainObject(draft)` check (the
  // module's OWN comment on that check explains why the leading `isPlainObject(draft)` in the main
  // condition is NOT independently provable the same way: `.signature` on a bare string reads as
  // `undefined`, so the outer `if` is already true via the signature-mismatch term regardless of
  // whether `draft` was ever checked for object-ness at all). What THIS test proves the GC gate
  // does correctly: a truthy-but-not-a-real-draft value (a bare string, distinct from NO-DRAFT's
  // `null`) must not fire a DELETE either -- `if (draft)` alone would have let this one slip
  // through where `isPlainObject(draft)` does not.
  it('MALFORMED (non-throwing): a `draft` that is a bare string, not an object, is rejected without a spurious GC delete', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => jsonResponse({ data: { draft: 'not-an-object' } }))
    const result = await loadFormDraftServer('tpl_1', 'sig-A', fetcher)
    expect(result).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetcher).toHaveBeenCalledTimes(1) // the GET only -- no follow-up DELETE
  })
})

describe('serverFormDraft.ts — empty-data deletes rather than writes (contract §1 "no meaningful value -> delete, not write")', () => {
  it('NEGATIVE (empty): saving data with no meaningful value issues a DELETE, never a PUT', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => jsonResponse({}, { status: 204 }))
    await saveFormDraftServer('tpl_2', 'sig', { amount: undefined, note: '', tags: [] }, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('/api/approvals/form-drafts/tpl_2', { method: 'DELETE' })
  })

  it('POSITIVE (meaningful): saving data with a real value issues a PUT with {signature, data} as the JSON body', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => jsonResponse({ data: { draft: null } }))
    await saveFormDraftServer('tpl_2', 'sig-xyz', { amount: 42 }, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [path, init] = fetcher.mock.calls[0]
    expect(path).toBe('/api/approvals/form-drafts/tpl_2')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ signature: 'sig-xyz', data: { amount: 42 } })
  })
})

describe('serverFormDraft.ts — saveFormDraftServer never throws (contract §1)', () => {
  it('POSITIVE: a normal (non-throwing) fetcher resolves without incident', async () => {
    // Gate2 P3-C: before the `jsonResponse` fix above, `status: 204` made THIS fetcher throw on
    // every call — "resolves without incident" was passing because saveFormDraftServer's own
    // `catch {}` swallows that self-inflicted TypeError, not because a real 204 was handled. That
    // makes the assertion below load-bearing against a REAL regression (wrong method/path/body),
    // not just against "did the mock's own construction bug get swallowed."
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => jsonResponse({}, { status: 204 }))
    await expect(saveFormDraftServer('tpl_3', 'sig', { amount: 1 }, fetcher)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledWith('/api/approvals/form-drafts/tpl_3', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: 'sig', data: { amount: 1 } }),
    })
  })

  it('NEGATIVE: a fetcher that REJECTS (network failure) does not propagate — saveFormDraftServer swallows it', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => {
      throw new Error('simulated network outage')
    })
    await expect(saveFormDraftServer('tpl_3', 'sig', { amount: 1 }, fetcher)).resolves.toBeUndefined()
  })

  it('NEGATIVE: a fetcher that rejects on the DELETE branch (empty data) is ALSO swallowed', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => {
      throw new Error('simulated network outage')
    })
    await expect(saveFormDraftServer('tpl_3', 'sig', {}, fetcher)).resolves.toBeUndefined()
  })
})

describe('serverFormDraft.ts — loadFormDraftServer never throws (contract §1)', () => {
  it('POSITIVE: a normal (non-throwing, ok) fetcher resolves with the parsed draft', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () =>
      jsonResponse({ data: { draft: { templateId: 'tpl_4', signature: 'sig', data: { amount: 7 }, savedAt: '2026-01-01T00:00:00.000Z' } } }),
    )
    await expect(loadFormDraftServer('tpl_4', 'sig', fetcher)).resolves.toEqual({ amount: 7 })
  })

  it('NEGATIVE: a fetcher that REJECTS (network failure) resolves to null, never throws', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => {
      throw new Error('simulated network outage')
    })
    await expect(loadFormDraftServer('tpl_4', 'sig', fetcher)).resolves.toBeNull()
  })

  it('NEGATIVE: a non-2xx response resolves to null, never throws, and does NOT attempt a GC delete (there was no draft body to distrust)', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => jsonResponse({}, { status: 500 }))
    await expect(loadFormDraftServer('tpl_4', 'sig', fetcher)).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1) // no follow-up DELETE
  })

  it('NEGATIVE: malformed JSON in the response body resolves to null, never throws', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await expect(loadFormDraftServer('tpl_4', 'sig', fetcher)).resolves.toBeNull()
  })
})

describe('serverFormDraft.ts — clearFormDraftServer / listFormDraftsServer never throw', () => {
  it('clearFormDraftServer swallows a rejecting fetcher', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => {
      throw new Error('simulated network outage')
    })
    await expect(clearFormDraftServer('tpl_5', fetcher)).resolves.toBeUndefined()
  })

  it('clearFormDraftServer issues a DELETE on the normal path (positive control)', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => jsonResponse({}, { status: 204 }))
    await clearFormDraftServer('tpl_5', fetcher)
    expect(fetcher).toHaveBeenCalledWith('/api/approvals/form-drafts/tpl_5', { method: 'DELETE' })
  })

  it('listFormDraftsServer swallows a rejecting fetcher and returns an empty list', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () => {
      throw new Error('simulated network outage')
    })
    await expect(listFormDraftsServer(fetcher)).resolves.toEqual([])
  })

  it('listFormDraftsServer returns well-formed entries and drops malformed ones (positive control the filter actually discriminates)', async () => {
    const fetcher = vi.fn<ServerFormDraftFetcher>(async () =>
      jsonResponse({
        data: {
          drafts: [
            { templateId: 'tpl_a', signature: 'sig-a', savedAt: '2026-01-01T00:00:00.000Z' },
            { templateId: 'tpl_b' }, // missing signature/savedAt — must be dropped
            { signature: 'sig-c', savedAt: '2026-01-01T00:00:00.000Z' }, // missing templateId — must be dropped
          ],
        },
      }),
    )
    const result = await listFormDraftsServer(fetcher)
    expect(result).toEqual([{ templateId: 'tpl_a', signature: 'sig-a', savedAt: '2026-01-01T00:00:00.000Z' }])
  })
})
