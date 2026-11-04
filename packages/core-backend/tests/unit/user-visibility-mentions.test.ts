import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/services/approval-instance-readability', () => ({
  canReadApprovalInstance: vi.fn(async () => true),
  isPlmApprovalId: () => false,
}))

import { listMentionCandidates } from '../../src/services/approval-comment-service'
import { escapeLikePattern, visibleUserPredicate } from '../../src/admin/user-visibility'

describe('visible user predicate', () => {
  it('names both lifecycle columns and escapes LIKE metacharacters', () => {
    expect(visibleUserPredicate()).toBe('deleted_at IS NULL AND purged_at IS NULL')
    expect(visibleUserPredicate('u')).toBe('u.deleted_at IS NULL AND u.purged_at IS NULL')
    expect(escapeLikePattern('100%_a\\b')).toBe('100\\%\\_a\\\\b')
  })
})

describe('mention search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('drops recycled and purged users from mention candidates', async () => {
    const calls: string[] = []
    const db = {
      query: async (sql: string) => {
        calls.push(sql)
        return { rows: [] }
      },
    }
    await listMentionCandidates(db, { instanceId: 'apr_1', viewerId: 'viewer', q: 'lin' })
    expect(calls[0]).toContain('u.deleted_at IS NULL')
    expect(calls[0]).toContain('u.purged_at IS NULL')
  })
})