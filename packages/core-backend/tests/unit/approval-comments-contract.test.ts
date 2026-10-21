import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

/**
 * Lock-10 (S2) §9.3 — the wire-contract test.
 *
 * `git grep -niE 'approvalComments|useApprovalComments|approval-comments'` over `apps` + `packages`
 * at this baseline returns NO S3a `CommentsApiClient` — this scan did NOT surface one
 * (`feedback_empty_read_is_not_absence`: absence-of-evidence, not evidence-of-absence). S2
 * therefore PUBLISHES the wire contract rather than consuming a client that may not exist: this
 * test asserts the EXACT JSON envelope of each route against a frozen literal (field names,
 * null-vs-absent for `body`/`editedAt`/`deletedAt`, and the `page` object's key names). Quote this
 * literal in the PR body under "S3a consumer contract" — it is what a future FE slice codes
 * against and what reds if a later change silently renames a field.
 *
 * Service-layer functions are mocked (real error classes, canned resolved views) so this test pins
 * ONLY the route's envelope shape — authorization/business-rule behavior is the real-DB suite's job
 * (`approval-comments.db.test.ts`), not this file's.
 */
const authState = vi.hoisted(() => ({
  user: { id: 'user-1', sub: 'user-1', userId: 'user-1', roles: ['admin'] } as Record<string, unknown> | null,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!authState.user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.user = authState.user as never
    next()
  },
}))

vi.mock('../../src/db/pg', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}))

const serviceMocks = vi.hoisted(() => ({
  createApprovalComment: vi.fn(),
  listApprovalComments: vi.fn(),
  editApprovalComment: vi.fn(),
  deleteApprovalComment: vi.fn(),
  listMentionCandidates: vi.fn(),
  notifyApprovalCommentMentions: vi.fn(),
}))

vi.mock('../../src/services/approval-comment-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/approval-comment-service')>(
    '../../src/services/approval-comment-service',
  )
  return {
    ...actual,
    createApprovalComment: serviceMocks.createApprovalComment,
    listApprovalComments: serviceMocks.listApprovalComments,
    editApprovalComment: serviceMocks.editApprovalComment,
    deleteApprovalComment: serviceMocks.deleteApprovalComment,
    listMentionCandidates: serviceMocks.listMentionCandidates,
    notifyApprovalCommentMentions: serviceMocks.notifyApprovalCommentMentions,
  }
})

import { approvalCommentsRouter } from '../../src/routes/approval-comments'
import { ApprovalCommentNotFoundError, ApprovalCommentDeletedError } from '../../src/services/approval-comment-service'

const FROZEN_COMMENT = {
  id: 'acmt_11111111-1111-1111-1111-111111111111',
  instanceId: 'inst-1',
  parentId: null,
  authorId: 'user-1',
  body: 'hello world',
  mentions: ['user-2'],
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  editedAt: null,
  deleted: false,
  deletedAt: null,
}

const FROZEN_TOMBSTONE = {
  ...FROZEN_COMMENT,
  body: null,
  mentions: [],
  editedAt: null,
  deleted: true,
  deletedAt: '2026-08-22T01:00:00.000Z',
}

describe('approval comments — S3a wire contract (frozen envelope literals)', () => {
  const app = express()
  app.use(express.json())
  app.use(approvalCommentsRouter())
  const pinned = usePinnedServer()

  beforeEach(() => {
    pinned.setApp(app)
    authState.user = { id: 'user-1', sub: 'user-1', userId: 'user-1', roles: ['admin'] }
    for (const fn of Object.values(serviceMocks)) fn.mockReset()
    serviceMocks.notifyApprovalCommentMentions.mockResolvedValue(undefined)
  })

  it('GET /api/approvals/:id/comments — frozen envelope', async () => {
    serviceMocks.listApprovalComments.mockResolvedValue({
      comments: [FROZEN_COMMENT, FROZEN_TOMBSTONE],
      page: { total: 2, limit: 50, offset: 0 },
    })
    const res = await request(pinned.url()).get('/api/approvals/inst-1/comments')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        comments: [FROZEN_COMMENT, FROZEN_TOMBSTONE],
        page: { total: 2, limit: 50, offset: 0 },
      },
    })
  })

  it('POST /api/approvals/:id/comments — frozen envelope, 201', async () => {
    serviceMocks.createApprovalComment.mockResolvedValue({ comment: FROZEN_COMMENT })
    const res = await request(pinned.url()).post('/api/approvals/inst-1/comments').send({ body: 'hello world' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ ok: true, data: { comment: FROZEN_COMMENT } })
  })

  it('PATCH /api/approvals/:id/comments/:commentId — frozen envelope, 200', async () => {
    const edited = { ...FROZEN_COMMENT, body: 'edited', editedAt: '2026-08-22T02:00:00.000Z' }
    serviceMocks.editApprovalComment.mockResolvedValue({ comment: edited })
    const res = await request(pinned.url()).patch(`/api/approvals/inst-1/comments/${FROZEN_COMMENT.id}`).send({ body: 'edited' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { comment: edited } })
  })

  it('DELETE /api/approvals/:id/comments/:commentId — frozen envelope, 200, tombstone shape', async () => {
    serviceMocks.deleteApprovalComment.mockResolvedValue({ comment: FROZEN_TOMBSTONE })
    const res = await request(pinned.url()).delete(`/api/approvals/inst-1/comments/${FROZEN_COMMENT.id}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { comment: FROZEN_TOMBSTONE } })
  })

  it('GET /api/approvals/:id/comments/mention-candidates — frozen envelope', async () => {
    serviceMocks.listMentionCandidates.mockResolvedValue({
      users: [{ id: 'user-2', name: 'User Two', email: 'user2@example.test' }],
    })
    const res = await request(pinned.url()).get('/api/approvals/inst-1/comments/mention-candidates?q=user')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: { users: [{ id: 'user-2', name: 'User Two', email: 'user2@example.test' }] },
    })
  })

  it('route-ordering: mention-candidates is never captured by :commentId', async () => {
    serviceMocks.listMentionCandidates.mockResolvedValue({ users: [] })
    const res = await request(pinned.url()).get('/api/approvals/inst-1/comments/mention-candidates')
    expect(res.status).toBe(200)
    expect(serviceMocks.listMentionCandidates).toHaveBeenCalledTimes(1)
    expect(serviceMocks.editApprovalComment).not.toHaveBeenCalled()
  })

  it('denial envelope is values-free: 404 APPROVAL_NOT_FOUND carries no `details` key', async () => {
    serviceMocks.listApprovalComments.mockRejectedValue(new ApprovalCommentNotFoundError())
    const res = await request(pinned.url()).get('/api/approvals/inst-1/comments')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval instance not found' },
    })
    expect(res.body.error).not.toHaveProperty('details')
  })

  it('denial envelope: 409 APPROVAL_COMMENT_DELETED on edit-a-tombstone', async () => {
    serviceMocks.editApprovalComment.mockRejectedValue(new ApprovalCommentDeletedError())
    const res = await request(pinned.url()).patch(`/api/approvals/inst-1/comments/${FROZEN_COMMENT.id}`).send({ body: 'x' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'APPROVAL_COMMENT_DELETED', message: 'Comment has been deleted' },
    })
  })
})
