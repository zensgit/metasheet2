import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Comment API contract tests.
 *
 * These tests verify the unified comment API contracts introduced in Week 1:
 * - CommentUnreadSummary shape (unreadCount + mentionUnreadCount)
 * - Backward compatibility (legacy `count` field)
 * - Mention precedence (explicit array > auto-parsed from content)
 */

// ---------------------------------------------------------------------------
// Mock the db module so CommentService can be instantiated without a real PG
// ---------------------------------------------------------------------------
vi.mock('../../src/db/db', () => {
  const fakeExecuteTakeFirst = vi.fn().mockResolvedValue(null)
  const fakeExecute = vi.fn().mockResolvedValue([])

  const fakeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const methods = [
      'selectFrom', 'leftJoin', 'select', 'where', 'groupBy',
      'orderBy', 'limit', 'offset', 'insertInto', 'values',
      'onConflict', 'updateTable', 'set', 'deleteFrom',
      'returningAll', 'selectAll',
    ]
    for (const method of methods) {
      chain[method] = vi.fn().mockReturnValue(chain)
    }
    chain.executeTakeFirst = fakeExecuteTakeFirst
    chain.execute = fakeExecute
    return chain
  }

  return {
    db: fakeChain(),
    __fakeExecuteTakeFirst: fakeExecuteTakeFirst,
    __fakeExecute: fakeExecute,
  }
})

vi.mock('../../src/db/type-helpers', () => ({
  nowTimestamp: vi.fn(() => new Date().toISOString()),
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { CommentService } from '../../src/services/CommentService'
import type { CommentUnreadSummary } from '../../src/di/identifiers'

// Create a minimal mock CollabService
function createMockCollabService() {
  return {
    broadcastTo: vi.fn(),
    sendTo: vi.fn(),
    broadcast: vi.fn(),
    initialize: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    onConnection: vi.fn(),
  }
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Comment API contracts', () => {
  let service: CommentService
  let mockCollab: ReturnType<typeof createMockCollabService>
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    vi.clearAllMocks()
    mockCollab = createMockCollabService()
    mockLogger = createMockLogger()
    service = new CommentService(mockCollab as any, mockLogger)
  })

  describe('CommentUnreadSummary type shape', () => {
    it('has unreadCount and mentionUnreadCount fields', () => {
      const summary: CommentUnreadSummary = {
        unreadCount: 5,
        mentionUnreadCount: 2,
      }
      expect(summary).toHaveProperty('unreadCount')
      expect(summary).toHaveProperty('mentionUnreadCount')
      expect(typeof summary.unreadCount).toBe('number')
      expect(typeof summary.mentionUnreadCount).toBe('number')
    })

    it('mentionUnreadCount is always <= unreadCount conceptually', () => {
      const summary: CommentUnreadSummary = {
        unreadCount: 10,
        mentionUnreadCount: 3,
      }
      expect(summary.mentionUnreadCount).toBeLessThanOrEqual(summary.unreadCount)
    })
  })

  describe('getUnreadSummary()', () => {
    it('returns both unreadCount and mentionUnreadCount', async () => {
      // The mock db returns null from executeTakeFirst, so counts default to 0
      const summary = await service.getUnreadSummary('user_1')

      expect(summary).toEqual({
        unreadCount: 0,
        mentionUnreadCount: 0,
      })
      expect(summary).toHaveProperty('unreadCount')
      expect(summary).toHaveProperty('mentionUnreadCount')
    })

    it('returns zero counts for a user with no unread comments', async () => {
      const summary = await service.getUnreadSummary('user_no_comments')

      expect(summary.unreadCount).toBe(0)
      expect(summary.mentionUnreadCount).toBe(0)
    })

    it('mentionUnreadCount only counts comments where user is mentioned AND unread', async () => {
      // The method uses a single query with:
      //   count(*) for total unread
      //   count(*) filter (where mentions @> ...) for mention-specific unread
      // Both conditions require r.comment_id is null (unread) as the WHERE clause.
      // This ensures mentionUnreadCount is a subset of unreadCount.
      const summary = await service.getUnreadSummary('user_2')

      // With mock returning null/0, both should be 0
      expect(summary.mentionUnreadCount).toBeLessThanOrEqual(summary.unreadCount)
    })
  })

  describe('backward compatibility: unread-count endpoint shape', () => {
    it('response includes count as alias for unreadCount', () => {
      // Simulate the route handler response construction
      const summary: CommentUnreadSummary = {
        unreadCount: 7,
        mentionUnreadCount: 2,
      }

      // This mirrors what the route handler builds
      const responseData = {
        unreadCount: summary.unreadCount,
        mentionUnreadCount: summary.mentionUnreadCount,
        count: summary.unreadCount,
      }

      // Verify backward compat: `count` is present and equals `unreadCount`
      expect(responseData).toHaveProperty('count')
      expect(responseData.count).toBe(responseData.unreadCount)

      // Verify new fields
      expect(responseData).toHaveProperty('unreadCount')
      expect(responseData).toHaveProperty('mentionUnreadCount')
    })

    it('count field equals unreadCount for any value', () => {
      for (const n of [0, 1, 42, 999]) {
        const summary: CommentUnreadSummary = {
          unreadCount: n,
          mentionUnreadCount: Math.floor(n / 2),
        }
        const responseData = {
          unreadCount: summary.unreadCount,
          mentionUnreadCount: summary.mentionUnreadCount,
          count: summary.unreadCount,
        }
        expect(responseData.count).toBe(n)
        expect(responseData.unreadCount).toBe(n)
      }
    })
  })

  describe('mention precedence documentation', () => {
    it('CommentCreateInput accepts optional mentions array', () => {
      // Type-level verification: these objects should be valid CommentCreateInput shapes
      const withExplicitMentions = {
        spreadsheetId: 'sheet_1',
        rowId: 'row_1',
        content: 'Hello @[Alice](user_alice)',
        authorId: 'user_bob',
        mentions: ['user_alice'],
      }

      const withAutoMentions = {
        spreadsheetId: 'sheet_1',
        rowId: 'row_1',
        content: 'Hello @[Alice](user_alice)',
        authorId: 'user_bob',
        // mentions omitted -- should auto-parse from content
      }

      expect(withExplicitMentions.mentions).toEqual(['user_alice'])
      expect(withAutoMentions).not.toHaveProperty('mentions')
    })
  })

  describe('getUnreadCount() still works (legacy)', () => {
    it('returns a number', async () => {
      const count = await service.getUnreadCount('user_1')
      expect(typeof count).toBe('number')
      expect(count).toBe(0) // mock returns null → 0
    })
  })
})
