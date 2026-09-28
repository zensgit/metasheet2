/**
 * Gate `impl-gate-B2-round1-20260918.md` P1-1, part (b): `routes/approvals.ts`'s
 * `publishApprovalCountsForUsers` is the ONE function all eight approval-action call sites share to
 * fire BOTH `approval:counts-updated` (`publishApprovalCountsUpdate`) and `todo:counts-updated`
 * (`publishTodoCountsUpdate`) on the same `uniqueUsers` set (design MD §5.1's "same predicate/same
 * trigger set" by-construction argument). No prior test asserted that wiring exists — the gate's own
 * M6 mutation (delete the `publishTodoCountsUpdate` call entirely) left the ENTIRE default-config
 * `vitest run` (932 files / 14716 tests) green.
 *
 * Scope, precisely: this gates `publishApprovalCountsForUsers`'s OWN body only. It does not — and
 * cannot — prove any of the eight route handlers actually calls this shared function instead of some
 * other path; that argument stays a by-construction / grep-based one (design MD §5.1), unchanged by
 * this test.
 */
import { describe, expect, it, vi } from 'vitest'

import { publishApprovalCountsUpdate } from '../../src/services/approval-realtime'
import { publishTodoCountsUpdate } from '../../src/services/todo-realtime'
import { publishApprovalCountsForUsers } from '../../src/routes/approvals'

vi.mock('../../src/services/approval-realtime', () => ({
  publishApprovalCountsUpdate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/todo-realtime', () => ({
  publishTodoCountsUpdate: vi.fn().mockResolvedValue(undefined),
}))

const mockedApprovalPublish = vi.mocked(publishApprovalCountsUpdate)
const mockedTodoPublish = vi.mocked(publishTodoCountsUpdate)

describe('publishApprovalCountsForUsers dual-publish wiring (B-2, todo-center-design-lock v2.14 §3/§4)', () => {
  it('fires todo:counts-updated for the SAME uniqueUsers set as approval:counts-updated, on every call', async () => {
    await publishApprovalCountsForUsers(
      undefined,
      [
        { userId: 'user-a', roles: ['finance'] },
        { userId: 'user-b', roles: ['plm'] },
        { userId: 'user-a', roles: ['finance'] }, // duplicate: exercises the same dedup as the real callers
      ],
      'decide',
    )

    expect(mockedApprovalPublish).toHaveBeenCalledTimes(2)
    expect(mockedTodoPublish).toHaveBeenCalledTimes(2)

    const approvalUserIds = mockedApprovalPublish.mock.calls.map((call) => call[0].userId).sort()
    const todoUserIds = mockedTodoPublish.mock.calls.map((call) => call[0].userId).sort()
    expect(approvalUserIds).toEqual(['user-a', 'user-b'])
    expect(todoUserIds).toEqual(approvalUserIds)

    // Same reason and same (deduped) roles reach both publishers for a given user — not just the
    // same user id set.
    for (const userId of approvalUserIds) {
      const approvalCall = mockedApprovalPublish.mock.calls.find((call) => call[0].userId === userId)
      const todoCall = mockedTodoPublish.mock.calls.find((call) => call[0].userId === userId)
      expect(approvalCall?.[0].reason).toBe('decide')
      expect(todoCall?.[0].reason).toBe('decide')
      expect(todoCall?.[0].roles).toEqual(approvalCall?.[0].roles)
    }
  })

  it('publishes nothing for an empty/blank-only user list (no spurious broadcasts)', async () => {
    mockedApprovalPublish.mockClear()
    mockedTodoPublish.mockClear()

    await publishApprovalCountsForUsers(undefined, [{ userId: '   ' }], 'mark-read')

    expect(mockedApprovalPublish).not.toHaveBeenCalled()
    expect(mockedTodoPublish).not.toHaveBeenCalled()
  })
})
