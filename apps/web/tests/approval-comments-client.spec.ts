import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * S3b — unit coverage for `approvalCommentsClient.ts`, the second `CommentsApiClient`
 * implementation (S3a's shared seam), mapped onto the S2 `/api/approvals/:id/comments*` routes.
 * Modeled on searchApprovalDirectoryUsers.spec.ts's approach: mock `../src/utils/api`'s `apiFetch`
 * directly (this module is not gated by USE_MOCK at all, so there is no mock branch to dodge).
 */
const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  createApprovalCommentsClient,
  fetchApprovalCommentMentionCandidates,
  ApprovalCommentsUnsupportedOperationError,
} from '../src/approvals/approvalCommentsClient'

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response
}

function commentView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acmt_1',
    instanceId: 'apv_1',
    parentId: null,
    authorId: 'user_1',
    body: 'hello',
    mentions: [],
    createdAt: '2026-08-22T09:00:00.000Z',
    updatedAt: '2026-08-22T09:00:00.000Z',
    editedAt: null,
    deleted: false,
    deletedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('createApprovalCommentsClient — listComments', () => {
  it('GETs with the closure instanceId, limit/offset, and reverses the oldest-first page to newest-first', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: {
        comments: [commentView({ id: 'acmt_1', createdAt: '2026-08-22T09:00:00.000Z' }), commentView({ id: 'acmt_2', createdAt: '2026-08-22T09:01:00.000Z' })],
        page: { total: 2, limit: 200, offset: 0 },
      },
    }))
    const client = createApprovalCommentsClient(() => 'apv_1')

    const result = await client.listComments({ containerId: 'apv_1', targetId: 'apv_1', targetFieldId: null })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/apv_1/comments?limit=200&offset=0')
    // Server order was [acmt_1, acmt_2] (oldest-first); the client reverses to newest-first.
    expect(result.comments.map((c) => c.id)).toEqual(['acmt_2', 'acmt_1'])
  })

  it('maps fieldId/targetFieldId to null, resolved to false, and omits reactions entirely (never fabricated)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: { comments: [commentView()], page: { total: 1, limit: 200, offset: 0 } },
    }))
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comments } = await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })

    expect(comments[0].fieldId).toBeNull()
    expect(comments[0].targetFieldId).toBeNull()
    expect(comments[0].resolved).toBe(false)
    expect(comments[0].reactions).toBeUndefined()
    expect(comments[0].containerId).toBe('apv_1')
    expect(comments[0].targetId).toBe('apv_1')
  })

  it('maps a tombstone: deleted true, content empty, authorId retained, editedAt untouched', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: {
        comments: [commentView({ id: 'acmt_del', body: null, mentions: [], deleted: true, deletedAt: '2026-08-22T10:00:00.000Z', editedAt: null })],
        page: { total: 1, limit: 200, offset: 0 },
      },
    }))
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comments } = await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })

    expect(comments[0].deleted).toBe(true)
    expect(comments[0].content).toBe('')
    expect(comments[0].authorId).toBe('user_1')
    expect(comments[0].editedAt).toBeNull()
  })

  it('paginates: loops limit=200/offset+=200 until a short page, concatenating all pages before the final reverse', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => commentView({ id: `acmt_${i}`, createdAt: `2026-08-22T00:${String(i).padStart(2, '0')}:00.000Z` }))
    const page2 = Array.from({ length: 50 }, (_, i) => commentView({ id: `acmt_${200 + i}`, createdAt: `2026-08-22T03:${String(i).padStart(2, '0')}:00.000Z` }))
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { comments: page1, page: { total: 250, limit: 200, offset: 0 } } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { comments: page2, page: { total: 250, limit: 200, offset: 200 } } }))
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comments } = await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(apiFetchMock.mock.calls[1]?.[0]).toBe('/api/approvals/apv_1/comments?limit=200&offset=200')
    expect(comments).toHaveLength(250)
    expect(client.truncated.value).toBe(false)
  })

  it('terminates on a zero-length page even if `total` claims more remain (total can move under concurrent creates)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: { comments: [], page: { total: 999, limit: 200, offset: 0 } },
    }))
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comments } = await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(comments).toHaveLength(0)
    // Gate N-2's `collected.length > 0` guard, pinned here: an empty first page must NOT flip
    // `truncated` true just because `total` (999) exceeds the (zero) rows collected — that would
    // render the truncation notice over an empty comment list.
    expect(client.truncated.value).toBe(false)
  })

  it.each([2200, 2150])('when truncation is unavoidable, keeps the NEWEST 2000 (not the oldest) and sets `truncated` — reset to false at the start of the NEXT call (gate P2-1) (total=%i)', async (total) => {
    // Server total (2200 / 2150), ASC order id_0 (oldest) .. id_{total-1} (newest). Capacity is
    // 2000, so the correct tail window is id_{total-2000}..id_{total-1} — the oldest
    // (total-2000) ids must be dropped, not the newest, because that is what the wrapper's
    // "仅显示最近的评论" notice promises. N2-1 (residual sweep): a SECOND, non-page-aligned total
    // (2150) is parameterized alongside the original page-aligned 2200 — a flooring-to-page-size
    // mutation of the offset computation produces the CORRECT window at 2200 (200 is already a
    // multiple of 200) but the WRONG one at 2150 (150 floors to 0), so 2200 alone cannot catch it.
    //
    // OFFSET-KEYED, not queue-positional (gate N-1, 2026-08-22): the mock derives each page's rows
    // from the `offset=` query param it was actually asked for, like a real server would — a
    // sequential `mockResolvedValueOnce` queue returns its pre-baked responses in CALL order
    // regardless of what offset the client requests, which let a mutated `offset` computation
    // (e.g. `offset = 0` instead of `offset = total - capacity`) still receive the correct
    // pre-baked tail pages and pass every id assertion below. This mock cannot make that mistake:
    // the wrong offset gets the wrong (real) page.
    const capacity = 2000
    const windowStart = total - capacity
    apiFetchMock.mockImplementation((url: string) => {
      const m = String(url).match(/offset=(\d+)/)
      const offset = m ? Number(m[1]) : 0
      const rows = Array.from(
        { length: Math.max(0, Math.min(200, total - offset)) },
        (_, i) => commentView({ id: `id_${offset + i}`, createdAt: `2026-08-22T00:00:${String(offset + i).padStart(4, '0').slice(-2)}.000Z` }),
      )
      return Promise.resolve(jsonResponse({ ok: true, data: { comments: rows, page: { total, limit: 200, offset } } }))
    })
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comments } = await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })

    // Id assertions come FIRST, deliberately ABOVE the call-count assertion below (gate N-1):
    // `toHaveBeenCalledTimes` reported red-by-itself for prior mutations and short-circuited
    // Vitest before these ever ran — moving them up means a mutation that preserves the fetch
    // COUNT but changes WHICH window was fetched (e.g. `offset = 0`) reds HERE, on an id
    // assertion, not on the count.
    expect(comments).toHaveLength(2000)
    expect(client.truncated.value).toBe(true)
    const ids = comments.map((c) => c.id)
    // Newest-first after the reverse: id_{total-1} leads, id_{windowStart} trails.
    expect(ids[0]).toBe(`id_${total - 1}`)
    expect(ids[ids.length - 1]).toBe(`id_${windowStart}`)
    // The oldest `windowStart` ids were dropped, not the newest.
    expect(ids).not.toContain(`id_${windowStart - 1}`)
    expect(ids).not.toContain('id_0')
    expect(ids).toContain(`id_${windowStart}`)
    expect(ids).toContain(`id_${total - 1}`)
    // 1 discovery request + 10 tail-window requests (holds for BOTH totals: 1 discovery + a full
    // 200-row-page tail of exactly `capacity` rows).
    expect(apiFetchMock).toHaveBeenCalledTimes(11)

    // A later short/empty load must not carry the stale truncation flag forward.
    apiFetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse({ ok: true, data: { comments: [], page: { total: 0, limit: 200, offset: 0 } } })),
    )
    await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })
    expect(client.truncated.value).toBe(false)
  })

  it('flags `truncated` when the effective server page is shorter than requested, even though `total` still fits within capacity (gate N-2 / PROBE-P1c)', async () => {
    // A backend whose OWN cap (route `MAX_APPROVAL_COMMENT_PAGE_SIZE` and/or service
    // `APPROVAL_COMMENT_MAX_LIMIT` — see the "server/client page-size coupling" describe block
    // below) is lower than what this client requests: it ignores `limit=200` and serves 100-row
    // pages, while `page.total` still honestly reports the full 500. `first.total` (500) is
    // `<= capacity` (2000), so this takes the "everything fits" branch — but the discovery page is
    // short (100, not 200), so that branch's while loop never even starts, and only 100 of the 500
    // rows are ever collected. Before gate finding N-2, this branch never checked
    // `collected.length` against `first.total`, so `truncated` stayed `false` and the tail 400
    // comments vanished with no notice (measured in the gate report as PROBE-P1c).
    const total = 500
    const serverPageSize = 100
    apiFetchMock.mockImplementation((url: string) => {
      const m = String(url).match(/offset=(\d+)/)
      const offset = m ? Number(m[1]) : 0
      const rows = Array.from(
        { length: Math.max(0, Math.min(serverPageSize, total - offset)) },
        (_, i) => commentView({ id: `id_${offset + i}` }),
      )
      return Promise.resolve(jsonResponse({ ok: true, data: { comments: rows, page: { total, limit: serverPageSize, offset } } }))
    })
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comments } = await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })

    // Id assertions FIRST (gate N-1 ordering convention, kept consistent with the P2-1 test
    // above): a mutation that discards the retry (keeping the old forward-pass window) but still
    // performs the extra fetch would preserve the call count, so the window itself must red here.
    expect(comments).toHaveLength(100)
    expect(client.truncated.value).toBe(true)
    // The retained window is the NEWEST 100 (id_400..id_499), matching the wrapper's own notice
    // ("仅显示最近的评论") — before the fix this silently kept the OLDEST 100 (id_0..id_99) instead.
    const ids = comments.map((c) => c.id)
    expect(ids[0]).toBe('id_499')
    expect(ids[ids.length - 1]).toBe('id_400')
    expect(ids).not.toContain('id_0')
    expect(ids).not.toContain('id_399')
    // N2-2 (residual sweep): the short-page branch now re-pages from the TAIL once truncation is
    // detected, so this is 1 discovery + 1 tail-retry fetch (was 1 before the fix — a live,
    // unflagged behaviour change on this branch, disclosed in the PR body).
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })

  it('N2-2 stale-total safety: a `first.total` far larger than what any retry page actually returns does NOT destroy the rows already collected (non-destructive retry)', async () => {
    // page.total claims 999, but only 3 real rows exist at offset 0 and EVERY other offset is
    // empty — the shape a stale/racing COUNT (concurrent deletes, COUNT-vs-SELECT skew) produces.
    // This is untested by the existing zero-page test (first.raw.length === 0 there short-circuits
    // the `collected.length > 0` guard before the retry logic is ever reached).
    const total = 999
    apiFetchMock.mockImplementation((url: string) => {
      const m = String(url).match(/offset=(\d+)/)
      const offset = m ? Number(m[1]) : 0
      if (offset !== 0) {
        return Promise.resolve(jsonResponse({ ok: true, data: { comments: [], page: { total, limit: 200, offset } } }))
      }
      const rows = [commentView({ id: 'id_0' }), commentView({ id: 'id_1' }), commentView({ id: 'id_2' })]
      return Promise.resolve(jsonResponse({ ok: true, data: { comments: rows, page: { total, limit: 200, offset } } }))
    })
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comments } = await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })

    expect(comments).toHaveLength(3)
    const ids = comments.map((c) => c.id)
    expect(ids).toEqual(['id_2', 'id_1', 'id_0']) // newest-first after reverse
    expect(client.truncated.value).toBe(true)
    // 1 discovery + 1 tail-retry fetch (the retry's own first page is empty, so the loop breaks
    // immediately — `retry.length === 0`, so the ORIGINAL 3-row `collected` is preserved, not wiped).
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not truncate when total fits exactly at capacity (2000) — no wasted discovery-only request', async () => {
    const fullPage = (offset: number) => Array.from({ length: 200 }, (_, i) => commentView({ id: `acmt_${offset + i}` }))
    for (let p = 0; p < 10; p += 1) {
      apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { comments: fullPage(p * 200), page: { total: 2000, limit: 200, offset: p * 200 } } }))
    }
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comments } = await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })

    expect(apiFetchMock).toHaveBeenCalledTimes(10)
    expect(comments).toHaveLength(2000)
    expect(client.truncated.value).toBe(false)
  })

  it('uses ONLY the getInstanceId closure for the URL, never `params.containerId` — a stale/mismatched target argument is ignored', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { comments: [], page: { total: 0, limit: 200, offset: 0 } } }))
    const client = createApprovalCommentsClient(() => 'apv_REAL')

    await client.listComments({ containerId: 'apv_WRONG', targetId: 'apv_WRONG', targetFieldId: null })

    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/apv_REAL/comments?limit=200&offset=0')
  })

  it('a live-changing closure (route-param navigation) is read fresh on every call — no client re-creation needed', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ ok: true, data: { comments: [], page: { total: 0, limit: 200, offset: 0 } } }))
    let current = 'apv_A'
    const client = createApprovalCommentsClient(() => current)

    await client.listComments({ containerId: current, targetId: current })
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/apv_A/comments?limit=200&offset=0')

    current = 'apv_B'
    await client.listComments({ containerId: current, targetId: current })
    expect(apiFetchMock.mock.calls[1]?.[0]).toBe('/api/approvals/apv_B/comments?limit=200&offset=0')
  })
})

describe('createApprovalCommentsClient — createComment/updateComment/deleteComment', () => {
  it('createComment POSTs {body, parentId, mentions} to the closure instanceId and maps the response', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { comment: commentView({ id: 'acmt_new', body: 'new body' }) } }, { status: 201 }))
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comment } = await client.createComment({
      containerId: 'apv_1', targetId: 'apv_1', content: 'new body', parentId: 'acmt_parent', mentions: ['user_2'],
    })

    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/apv_1/comments')
    const [, options] = apiFetchMock.mock.calls[0] as [string, { method: string; body: string }]
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({ body: 'new body', parentId: 'acmt_parent', mentions: ['user_2'] })
    expect(comment.id).toBe('acmt_new')
    expect(comment.content).toBe('new body')
  })

  it('updateComment PATCHes /api/approvals/:instanceId/comments/:commentId with {body, mentions}', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { comment: commentView({ id: 'acmt_1', body: 'edited', editedAt: '2026-08-22T11:00:00.000Z' }) } }))
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comment } = await client.updateComment('acmt_1', { content: 'edited', mentions: [] })

    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/apv_1/comments/acmt_1')
    const [, options] = apiFetchMock.mock.calls[0] as [string, { method: string; body: string }]
    expect(options.method).toBe('PATCH')
    expect(JSON.parse(options.body)).toEqual({ body: 'edited', mentions: [] })
    expect(comment.editedAt).toBe('2026-08-22T11:00:00.000Z')
  })

  it('deleteComment DELETEs /api/approvals/:instanceId/comments/:commentId and resolves void even though the 200 body is the tombstone', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { comment: commentView({ id: 'acmt_1', deleted: true, body: null }) } }))
    const client = createApprovalCommentsClient(() => 'apv_1')

    const result = await client.deleteComment('acmt_1')

    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/apv_1/comments/acmt_1')
    expect((apiFetchMock.mock.calls[0]?.[1] as { method: string }).method).toBe('DELETE')
    expect(result).toBeUndefined()
  })

  it.each([
    ['APPROVAL_COMMENT_DELETED', 409, 'Comment has been deleted'],
    ['APPROVAL_COMMENT_NOT_FOUND', 404, 'Approval comment not found'],
    ['VALIDATION_ERROR', 400, 'body must not be blank'],
  ])('a %s denial surfaces via approvalRequestError with .status=%d and .code set', async (code, status, message) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: { code, message } }, { status, ok: false }))
    const client = createApprovalCommentsClient(() => 'apv_1')

    await expect(client.updateComment('acmt_1', { content: 'x' })).rejects.toMatchObject({ status, code, message })
  })
})

describe('createApprovalCommentsClient — capability absence (never fabricated success)', () => {
  it('resolveComment/addReaction/removeReaction all throw ApprovalCommentsUnsupportedOperationError WITHOUT calling apiFetch', async () => {
    const client = createApprovalCommentsClient(() => 'apv_1')

    await expect(client.resolveComment('acmt_1')).rejects.toBeInstanceOf(ApprovalCommentsUnsupportedOperationError)
    await expect(client.addReaction('acmt_1', '👍')).rejects.toBeInstanceOf(ApprovalCommentsUnsupportedOperationError)
    await expect(client.removeReaction('acmt_1', '👍')).rejects.toBeInstanceOf(ApprovalCommentsUnsupportedOperationError)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})

describe('fetchApprovalCommentMentionCandidates', () => {
  it('fetches with no `q` by default and maps {users} to {id,name,email}', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: { users: [{ id: 'user_2', name: 'Bob', email: 'bob@x.io' }] },
    }))

    const result = await fetchApprovalCommentMentionCandidates('apv_1')

    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/apv_1/comments/mention-candidates')
    expect(result).toEqual([{ id: 'user_2', name: 'Bob', email: 'bob@x.io' }])
  })

  it('drops entries with a blank id', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: { users: [{ id: '', name: 'No Id', email: '' }, { id: 'user_3', name: 'Carol', email: '' }] },
    }))

    const result = await fetchApprovalCommentMentionCandidates('apv_1')

    expect(result).toEqual([{ id: 'user_3', name: 'Carol', email: '' }])
  })
})

describe('server/client page-size coupling (gate NIT-1 / N-2)', () => {
  // `APPROVAL_COMMENT_LIST_PAGE_SIZE` (this file, private) must not exceed the server's EFFECTIVE
  // page size, which is `min` of TWO independent server-side clamps, not one:
  //   1. `MAX_APPROVAL_COMMENT_PAGE_SIZE` (routes/approval-comments.ts) — bounds the QUERY-STRING
  //      `limit` param via that route's own `parsePaging` before it ever reaches the service.
  //   2. `APPROVAL_COMMENT_MAX_LIMIT` (services/approval-comment-service.ts) — governs
  //      `clampLimit`, the clamp actually applied to the SQL `LIMIT` in `listApprovalComments`.
  // Gate finding N-2 (2026-08-22): the original version of this guard scanned only #1 while its
  // OWN prose named `clampLimit` (#2's mechanism) as the risk — so a drop in `APPROVAL_COMMENT_
  // MAX_LIMIT` alone (#1 unchanged) passed this guard silently. Both are scanned below and the
  // effective cap is their `min`, matching what the DB query actually receives.
  //
  // If the effective server cap ever drops below what this client requests, `clampLimit` silently
  // serves a SHORTER page than asked for — this client's short-page break fires on page 1 (never
  // consulting `page.total`), silently dropping the tail with NO truncation notice (measured in
  // the gate report: 400 of 500 comments lost, `truncated` stayed `false`; PROBE-P1c/N-2 above now
  // pins that this client itself sets `truncated` correctly once it observes a short page — this
  // guard's job is only to keep the two constants from drifting apart in the first place). This is
  // a mechanical text-scan drift guard, not a runtime import (neither constant is exported, and a
  // cross-package runtime import from `apps/web`'s vitest environment into `packages/core-backend`
  // is not how this repo wires such couplings) — it fails loudly the moment any of the three
  // literals changes without the others, which is the actual failure mode this NIT describes.
  //
  // KNOWN LIMITATION (checked, not assumed): `.github/workflows/approval-web-guard.yml`'s `paths:`
  // blocks list only `apps/web/**` files — `packages/core-backend/**` is NOT among them (verified
  // by grep against this repo's current workflow, 2026-08-22). A backend-only PR that lowers
  // either server constant therefore never triggers THIS guard at all — it is green-by-not-running
  // for that specific change shape, not green-by-passing. Closing that requires either a
  // backend-side assertion (this file has no standing to add one) or adding
  // `packages/core-backend/**` to the FE guard's paths (its own blast radius — every backend PR
  // would start running the full FE test battery — and is an owner-scope tradeoff, not decided
  // here). This test DOES catch the drift on any PR that touches ANY of the three files, or any
  // FE-side PR (since `approval-comments-client.spec.ts` is itself in the guard's own path list).
  it('the client page size does not exceed the server\'s EFFECTIVE cap (route parsePaging AND service clampLimit)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const routeSrc = readFileSync(
      join(__dirname, '../../../packages/core-backend/src/routes/approval-comments.ts'),
      'utf8',
    )
    const serviceSrc = readFileSync(
      join(__dirname, '../../../packages/core-backend/src/services/approval-comment-service.ts'),
      'utf8',
    )
    const routeMatch = routeSrc.match(/MAX_APPROVAL_COMMENT_PAGE_SIZE\s*=\s*(\d+)/)
    expect(routeMatch, 'MAX_APPROVAL_COMMENT_PAGE_SIZE not found in approval-comments.ts — update this guard\'s regex if the constant was renamed').toBeTruthy()
    const serviceMatch = serviceSrc.match(/APPROVAL_COMMENT_MAX_LIMIT\s*=\s*(\d+)/)
    expect(serviceMatch, 'APPROVAL_COMMENT_MAX_LIMIT not found in approval-comment-service.ts — this constant governs `clampLimit`, the SQL LIMIT clamp; update this guard\'s regex if it was renamed').toBeTruthy()
    const routeMax = Number(routeMatch![1])
    const serviceMax = Number(serviceMatch![1])
    const effectiveServerMax = Math.min(routeMax, serviceMax)
    // Kept as a literal (not an import) — see this describe block's own note.
    const CLIENT_PAGE_SIZE = 200
    expect(CLIENT_PAGE_SIZE).toBeLessThanOrEqual(effectiveServerMax)
  })
})
