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
  })

  it('caps at 10 pages (2000 comments) and sets `truncated` — reset to false at the start of the NEXT call', async () => {
    const fullPage = () => Array.from({ length: 200 }, (_, i) => commentView({ id: `acmt_${Math.random()}_${i}` }))
    for (let p = 0; p < 10; p += 1) {
      apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { comments: fullPage(), page: { total: 100000, limit: 200, offset: p * 200 } } }))
    }
    const client = createApprovalCommentsClient(() => 'apv_1')

    const { comments } = await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })

    expect(apiFetchMock).toHaveBeenCalledTimes(10)
    expect(comments).toHaveLength(2000)
    expect(client.truncated.value).toBe(true)

    // A later short/empty load must not carry the stale truncation flag forward.
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { comments: [], page: { total: 0, limit: 200, offset: 0 } } }))
    await client.listComments({ containerId: 'apv_1', targetId: 'apv_1' })
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
