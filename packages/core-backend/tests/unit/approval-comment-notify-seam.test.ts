import { describe, expect, it } from 'vitest'

/**
 * Lock-10 (S2) OD-S1-15 / G-S1-9 — pins the COLD module initializer of the notify seam, not the
 * test-reset helper.
 *
 * `approval-comments.db.test.ts`'s C-11 negative test calls
 * `resetApprovalCommentNotifyCheckerForTests()` before asserting zero deliveries — necessary
 * there because that suite boots a real `MetaSheetServer`, whose production wiring
 * (`index.ts`) overwrites the module-level seam with a real checker in `beforeAll`, so the raw
 * initializer is unreachable by the time any test in that file runs. That makes the negative
 * assertion there a pin on the RESET helper, not on `let approvalCommentNotifyChecker: ... =
 * async () => false` itself — mutating only that line does not red it (confirmed: mutating both
 * the initializer AND the reset helper is required to red the real-DB suite's negative test,
 * which is not the same probe the contract names).
 *
 * THIS file never constructs a server and never calls the reset helper, so — vitest's default
 * `pool: 'forks'` gives each test file a fresh module registry — the import below observes the
 * module's COLD state: whatever `approvalCommentNotifyChecker` was initialized to, unmodified.
 * `notifyApprovalCommentMentions` is called directly against that cold state.
 */
import { notifyApprovalCommentMentions, setApprovalCommentMentionDelivery } from '../../src/services/approval-comment-service'

describe('approval-comment notify seam — cold initializer is fail-closed (OD-S1-15)', () => {
  it('with the module freshly loaded (no server boot, no test-reset helper called), a mention delivers ZERO times', async () => {
    const deliveries: Array<{ userId: string; event: string; payload: unknown }> = []
    setApprovalCommentMentionDelivery((userId, event, payload) => deliveries.push({ userId, event, payload }))

    await notifyApprovalCommentMentions({
      instanceId: 'cold-inst',
      commentId: 'cold-cmt',
      authorId: 'cold-author',
      mentions: ['cold-mentioned-user'],
    })

    expect(deliveries.length).toBe(0)
  })
})
