import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ILogger } from '../../src/di/identifiers'

// ── DB mock ──────────────────────────────────────────────────────────────────
// Each top-level db method call (selectFrom, insertInto, etc.) creates a fresh
// chain with its own execute/executeTakeFirst. We track all chains created and
// can pre-program their results via the results queue.

const executeResults: unknown[] = []
const executeTakeFirstResults: unknown[] = []

vi.mock('../../src/db/db', () => {
  // Shared result queues accessible from factory
  const _executeResults: unknown[] = []
  const _executeTakeFirstResults: unknown[] = []

  function makeChain(): Record<string, unknown> {
    const self: Record<string, unknown> = {}
    const chainFn = (..._args: unknown[]) => self
    const methods = [
      'selectFrom', 'selectAll', 'select', 'where', 'orderBy',
      'limit', 'offset', 'groupBy', 'insertInto', 'values',
      'onConflict', 'columns', 'doUpdateSet',
      'updateTable', 'set', 'deleteFrom', 'returningAll',
      'leftJoin',
    ]
    for (const m of methods) {
      self[m] = vi.fn(chainFn)
    }
    self.execute = vi.fn(async () => {
      return _executeResults.shift() ?? []
    })
    self.executeTakeFirst = vi.fn(async () => {
      return _executeTakeFirstResults.shift()
    })
    return self
  }

  const rootChain: Record<string, unknown> = {}
  // Root-level methods create a new chain each time they are called
  for (const m of ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom']) {
    rootChain[m] = vi.fn(() => makeChain())
  }

  const dbProxy = new Proxy(rootChain, {
    get(target, prop) {
      if (prop === 'transaction') {
        return () => ({
          execute: async (fn: (trx: unknown) => Promise<void>) => {
            const trxRoot: Record<string, unknown> = {}
            for (const m of ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom']) {
              trxRoot[m] = vi.fn(() => makeChain())
            }
            await fn(trxRoot)
          },
        })
      }
      return target[prop as string]
    },
  })

  return {
    db: dbProxy,
    __executeResults: _executeResults,
    __executeTakeFirstResults: _executeTakeFirstResults,
  }
})

vi.mock('../../src/db/type-helpers', () => ({
  nowTimestamp: () => 'NOW()',
}))

// ── CollabService mock ──────────────────────────────────────────────────────

const mockCollabService = {
  broadcastTo: vi.fn(),
  sendTo: vi.fn(),
  broadcast: vi.fn(),
  initialize: vi.fn(),
  join: vi.fn(),
  leave: vi.fn(),
  onConnection: vi.fn(),
}

const mockLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const mockNotifyRecordSubscribersWithKysely = vi.fn()
vi.mock('../../src/multitable/record-subscription-service', () => ({
  notifyRecordSubscribersWithKysely: (...args: unknown[]) => mockNotifyRecordSubscribersWithKysely(...args),
}))

// ── Import SUT after mocks ──────────────────────────────────────────────────

import { CommentService, CommentValidationError, CommentNotFoundError, CommentAccessError, CommentConflictError } from '../../src/services/CommentService'
import type { CollabService } from '../../src/services/CollabService'

// ── Get the shared result queues ────────────────────────────────────────────

let queueExec: unknown[]
let queueTakeFirst: unknown[]

beforeEach(async () => {
  const dbModule = await import('../../src/db/db') as unknown as {
    __executeResults: unknown[]
    __executeTakeFirstResults: unknown[]
  }
  queueExec = dbModule.__executeResults
  queueTakeFirst = dbModule.__executeTakeFirstResults
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCommentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmt_test-1',
    spreadsheet_id: 'sheet-1',
    row_id: 'row-1',
    field_id: null,
    content: 'Hello world',
    author_id: 'user-author',
    parent_id: null,
    resolved: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    mentions: '[]',
    ...overrides,
  }
}

/** Push results for executeTakeFirst calls in order */
function pushTakeFirst(...results: unknown[]) {
  queueTakeFirst.push(...results)
}

/** Push results for execute calls in order */
function pushExec(...results: unknown[]) {
  queueExec.push(...results)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CommentService', () => {
  let service: CommentService

  beforeEach(() => {
    vi.clearAllMocks()
    // Clear result queues
    queueExec.length = 0
    queueTakeFirst.length = 0
    mockNotifyRecordSubscribersWithKysely.mockResolvedValue({ inserted: 0, userIds: [] })
    service = new CommentService(
      mockCollabService as unknown as CollabService,
      mockLogger,
    )
  })

  // ── parseMentions (tested via createComment / updateComment) ──────────

  describe('mention parsing via createComment', () => {
    it('parses @[Name](userId) format from content', async () => {
      // createComment flow:
      // 1. insertInto -> execute (insert)
      // 2. selectFrom -> executeTakeFirst (getComment reload)
      // 3. insertInto -> execute (markCommentRead)
      pushExec([]) // insert comment
      pushTakeFirst(makeCommentRow({
        id: 'cmt_new',
        content: 'Hey @[John](user-123) check this',
        mentions: JSON.stringify(['user-123']),
      })) // getComment reload
      pushExec([]) // markCommentRead insert

      const comment = await service.createComment({
        spreadsheetId: 'sheet-1',
        rowId: 'row-1',
        content: 'Hey @[John](user-123) check this',
        authorId: 'user-author',
      })

      expect(comment.mentions).toEqual(['user-123'])
    })

    it('notifies record watchers for new comments and suppresses the author in the notifier', async () => {
      pushExec([]) // insert
      pushTakeFirst(makeCommentRow({
        id: 'cmt_watch',
        spreadsheet_id: 'sheet-1',
        row_id: 'row-1',
      }))
      pushExec([]) // markCommentRead

      await service.createComment({
        spreadsheetId: 'sheet-1',
        rowId: 'row-1',
        content: 'Watcher update',
        authorId: 'user-author',
      })

      expect(mockNotifyRecordSubscribersWithKysely).toHaveBeenCalledWith(expect.anything(), {
        sheetId: 'sheet-1',
        recordId: 'row-1',
        eventType: 'comment.created',
        actorId: 'user-author',
        commentId: 'cmt_watch',
      })
    })

    it('handles multiple mentions in one content string', async () => {
      const mentionContent = '@[Alice](user-a) and @[Bob](user-b) please review'
      pushExec([]) // insert
      pushTakeFirst(makeCommentRow({
        id: 'cmt_multi',
        content: mentionContent,
        mentions: JSON.stringify(['user-a', 'user-b']),
      }))
      pushExec([]) // markCommentRead

      const comment = await service.createComment({
        spreadsheetId: 'sheet-1',
        rowId: 'row-1',
        content: mentionContent,
        authorId: 'user-author',
      })

      expect(comment.mentions).toContain('user-a')
      expect(comment.mentions).toContain('user-b')
      expect(comment.mentions).toHaveLength(2)
    })

    it('returns empty array for content with no mentions', async () => {
      pushExec([]) // insert
      pushTakeFirst(makeCommentRow({
        id: 'cmt_none',
        content: 'Just a regular comment',
        mentions: '[]',
      }))
      pushExec([]) // markCommentRead

      const comment = await service.createComment({
        spreadsheetId: 'sheet-1',
        rowId: 'row-1',
        content: 'Just a regular comment',
        authorId: 'user-author',
      })

      expect(comment.mentions).toEqual([])
    })

    it('deduplicates mentions', async () => {
      const content = '@[John](user-123) said @[John](user-123) twice'
      pushExec([]) // insert
      pushTakeFirst(makeCommentRow({
        id: 'cmt_dedup',
        content,
        mentions: JSON.stringify(['user-123']),
      }))
      pushExec([]) // markCommentRead

      const comment = await service.createComment({
        spreadsheetId: 'sheet-1',
        rowId: 'row-1',
        content,
        authorId: 'user-author',
      })

      expect(comment.mentions).toEqual(['user-123'])
    })

    it('uses explicit mentions array when provided', async () => {
      pushExec([]) // insert
      pushTakeFirst(makeCommentRow({
        id: 'cmt_explicit',
        content: 'Some content',
        mentions: JSON.stringify(['user-x', 'user-y']),
      }))
      pushExec([]) // markCommentRead

      const comment = await service.createComment({
        spreadsheetId: 'sheet-1',
        rowId: 'row-1',
        content: 'Some content',
        authorId: 'user-author',
        mentions: ['user-x', 'user-y'],
      })

      expect(comment.mentions).toEqual(['user-x', 'user-y'])
    })
  })

  // ── createComment: auto-mark-as-read ──────────────────────────────────

  describe('createComment auto-marks as read for author', () => {
    it('calls markCommentRead for the author after creating', async () => {
      const markReadSpy = vi.spyOn(service, 'markCommentRead').mockResolvedValue(undefined)

      pushExec([]) // insert comment
      pushTakeFirst(makeCommentRow({ id: 'cmt_auto-read', author_id: 'user-author' }))

      await service.createComment({
        spreadsheetId: 'sheet-1',
        rowId: 'row-1',
        content: 'test',
        authorId: 'user-author',
      })

      // The comment ID is generated internally (randomUUID), so we match any string starting with 'cmt_'
      expect(markReadSpy).toHaveBeenCalledTimes(1)
      const [commentId, authorId] = markReadSpy.mock.calls[0]
      expect(commentId).toMatch(/^cmt_/)
      expect(authorId).toBe('user-author')
      markReadSpy.mockRestore()
    })
  })

  // ── getInbox ──────────────────────────────────────────────────────────

  describe('getInbox', () => {
    it('returns comments where user is mentioned', async () => {
      const inboxRow = {
        ...makeCommentRow({
          mentions: JSON.stringify(['user-viewer']),
          author_id: 'user-other',
        }),
        unread: true,
        mentioned: true,
        base_id: 'base-1',
        sheet_id: 'sheet-1',
        view_id: 'view-1',
        record_id: 'row-1',
      }

      // getInbox does: executeTakeFirst (count), execute (rows)
      pushTakeFirst({ c: 1 })
      pushExec([inboxRow])

      const result = await service.getInbox('user-viewer')

      expect(result.total).toBe(1)
      expect(result.items).toHaveLength(1)
      expect(result.items[0].mentioned).toBe(true)
    })

    it('marks mentioned + unread correctly', async () => {
      const mentionedUnread = {
        ...makeCommentRow({
          id: 'cmt_1',
          mentions: JSON.stringify(['user-viewer']),
          author_id: 'user-other',
        }),
        unread: true,
        mentioned: true,
        base_id: null,
        sheet_id: 'sheet-1',
        view_id: null,
        record_id: 'row-1',
      }
      const mentionedRead = {
        ...makeCommentRow({
          id: 'cmt_2',
          mentions: JSON.stringify(['user-viewer']),
          author_id: 'user-other',
        }),
        unread: false,
        mentioned: true,
        base_id: null,
        sheet_id: 'sheet-1',
        view_id: null,
        record_id: 'row-2',
      }

      pushTakeFirst({ c: 2 })
      pushExec([mentionedUnread, mentionedRead])

      const result = await service.getInbox('user-viewer')

      expect(result.total).toBe(2)
      expect(result.items[0].unread).toBe(true)
      expect(result.items[0].mentioned).toBe(true)
      expect(result.items[1].unread).toBe(false)
      expect(result.items[1].mentioned).toBe(true)
    })

    it("excludes author's own comments (author_id != userId filter)", async () => {
      pushTakeFirst({ c: 0 })
      pushExec([])

      const result = await service.getInbox('user-author')

      expect(result.total).toBe(0)
      expect(result.items).toHaveLength(0)
    })
  })

  // ── getUnreadCount ────────────────────────────────────────────────────

  describe('getUnreadCount', () => {
    it('counts only comments where user has no read record', async () => {
      pushTakeFirst({ c: 5 })

      const count = await service.getUnreadCount('user-viewer')

      expect(count).toBe(5)
    })

    it("excludes user's own comments from unread count", async () => {
      pushTakeFirst({ c: 0 })

      const count = await service.getUnreadCount('user-author')

      expect(count).toBe(0)
    })

    it('returns 0 when no unread comments', async () => {
      pushTakeFirst({ c: 0 })

      const count = await service.getUnreadCount('user-1')

      expect(count).toBe(0)
    })

    it('returns 0 when query returns undefined', async () => {
      pushTakeFirst(undefined)

      const count = await service.getUnreadCount('user-1')

      expect(count).toBe(0)
    })
  })

  // ── markCommentRead ───────────────────────────────────────────────────

  describe('markCommentRead', () => {
    it('inserts a read record without throwing', async () => {
      pushExec([])

      await expect(service.markCommentRead('cmt_1', 'user-1')).resolves.not.toThrow()
    })

    it('is idempotent (ON CONFLICT updates read_at)', async () => {
      pushExec([])
      pushExec([])

      await service.markCommentRead('cmt_1', 'user-1')
      await expect(service.markCommentRead('cmt_1', 'user-1')).resolves.not.toThrow()
    })
  })

  // ── deleteComment ─────────────────────────────────────────────────────

  describe('deleteComment', () => {
    it('broadcasts comment:deleted event after deletion', async () => {
      const row = makeCommentRow({ id: 'cmt_del', author_id: 'user-author' })
      // getRequiredCommentRow -> executeTakeFirst
      pushTakeFirst(row)
      // child lookup -> executeTakeFirst
      pushTakeFirst(undefined)

      await service.deleteComment('cmt_del', 'user-author')

      const deletedCalls = mockCollabService.broadcastTo.mock.calls.filter(
        (call: unknown[]) => call[1] === 'comment:deleted',
      )
      expect(deletedCalls.length).toBeGreaterThanOrEqual(1)
      expect(deletedCalls[0][2]).toMatchObject({
        spreadsheetId: 'sheet-1',
        rowId: 'row-1',
        commentId: 'cmt_del',
      })
    })

    it('broadcasts comment:activity with kind deleted to inbox room', async () => {
      const row = makeCommentRow({ id: 'cmt_del2', author_id: 'user-author' })
      pushTakeFirst(row)
      pushTakeFirst(undefined)

      await service.deleteComment('cmt_del2', 'user-author')

      const activityCalls = mockCollabService.broadcastTo.mock.calls.filter(
        (call: unknown[]) => call[1] === 'comment:activity',
      )
      expect(activityCalls.length).toBeGreaterThanOrEqual(1)
      const payload = activityCalls[0][2] as { kind: string }
      expect(payload.kind).toBe('deleted')
    })

    it('rejects deletion by non-author', async () => {
      const row = makeCommentRow({ id: 'cmt_nope', author_id: 'user-author' })
      pushTakeFirst(row)

      await expect(service.deleteComment('cmt_nope', 'user-other'))
        .rejects.toThrow(CommentAccessError)
    })

    it('rejects deletion of comment with replies', async () => {
      const row = makeCommentRow({ id: 'cmt_parent', author_id: 'user-author' })
      pushTakeFirst(row)           // getRequiredCommentRow
      pushTakeFirst({ id: 'cmt_child' }) // child found

      await expect(service.deleteComment('cmt_parent', 'user-author'))
        .rejects.toThrow(CommentConflictError)
    })
  })

  // ── updateComment ─────────────────────────────────────────────────────

  describe('updateComment', () => {
    it('rejects edit by non-author', async () => {
      const row = makeCommentRow({ id: 'cmt_edit', author_id: 'user-author' })
      pushTakeFirst(row) // getRequiredCommentRow

      await expect(service.updateComment('cmt_edit', 'user-other', { content: 'new' }))
        .rejects.toThrow(CommentAccessError)
    })

    it('rejects edit on resolved comment', async () => {
      const row = makeCommentRow({ id: 'cmt_resolved', author_id: 'user-author', resolved: true })
      pushTakeFirst(row) // getRequiredCommentRow

      await expect(service.updateComment('cmt_resolved', 'user-author', { content: 'new' }))
        .rejects.toThrow(CommentConflictError)
    })

    it('sends mention notification to newly mentioned users only', async () => {
      const existingRow = makeCommentRow({
        id: 'cmt_up',
        author_id: 'user-author',
        mentions: JSON.stringify(['user-old']),
      })
      const updatedRow = makeCommentRow({
        id: 'cmt_up',
        author_id: 'user-author',
        content: '@[Old](user-old) @[New](user-new)',
        mentions: JSON.stringify(['user-old', 'user-new']),
      })

      pushTakeFirst(existingRow) // getRequiredCommentRow
      pushExec([])               // updateTable execute
      pushTakeFirst(updatedRow)  // getComment reload

      await service.updateComment('cmt_up', 'user-author', {
        content: '@[Old](user-old) @[New](user-new)',
      })

      const sendToCalls = mockCollabService.sendTo.mock.calls.filter(
        (call: unknown[]) => call[1] === 'comment:mention',
      )
      const mentionedUserIds = sendToCalls.map((call: unknown[]) => call[0])
      expect(mentionedUserIds).toContain('user-new')
      expect(mentionedUserIds).not.toContain('user-old')
    })
  })

  // ── resolveComment ────────────────────────────────────────────────────

  describe('resolveComment', () => {
    it('broadcasts comment:resolved to rooms', async () => {
      pushTakeFirst(makeCommentRow({ id: 'cmt_res' }))

      await service.resolveComment('cmt_res')

      const resolvedCalls = mockCollabService.broadcastTo.mock.calls.filter(
        (call: unknown[]) => call[1] === 'comment:resolved',
      )
      expect(resolvedCalls.length).toBeGreaterThanOrEqual(2) // record + sheet rooms
    })
  })

  // ── Error classes ─────────────────────────────────────────────────────

  describe('error classes', () => {
    it('CommentValidationError has correct name', () => {
      const err = new CommentValidationError('bad input')
      expect(err.name).toBe('CommentValidationError')
      expect(err.message).toBe('bad input')
      expect(err).toBeInstanceOf(Error)
    })

    it('CommentNotFoundError has correct name', () => {
      const err = new CommentNotFoundError('not found')
      expect(err.name).toBe('CommentNotFoundError')
    })

    it('CommentAccessError has correct name', () => {
      const err = new CommentAccessError('forbidden')
      expect(err.name).toBe('CommentAccessError')
    })

    it('CommentConflictError has correct name', () => {
      const err = new CommentConflictError('conflict')
      expect(err.name).toBe('CommentConflictError')
    })
  })

  // ── getComments ───────────────────────────────────────────────────────

  describe('getComments', () => {
    it('returns mapped items and total', async () => {
      // getComments does: executeTakeFirst (total count), execute (rows)
      pushTakeFirst({ c: 2 })
      pushExec([
        makeCommentRow({ id: 'cmt_a' }),
        makeCommentRow({ id: 'cmt_b' }),
      ])

      const result = await service.getComments('sheet-1')

      expect(result.total).toBe(2)
      expect(result.items).toHaveLength(2)
      expect(result.items[0].id).toBe('cmt_a')
      expect(result.items[1].id).toBe('cmt_b')
    })

    it('clamps limit to [1, 200]', async () => {
      pushTakeFirst({ c: 0 })
      pushExec([])

      const result = await service.getComments('sheet-1', { limit: 999 })

      expect(result.total).toBe(0)
    })
  })

  // ── getMentionSummary ─────────────────────────────────────────────────

  describe('getMentionSummary', () => {
    it('returns empty for blank userId', async () => {
      const result = await service.getMentionSummary('sheet-1', '  ')

      expect(result.unresolvedMentionCount).toBe(0)
      expect(result.items).toEqual([])
    })

    it('aggregates mention data by row', async () => {
      pushExec([
        { row_id: 'row-1', field_id: 'fld-a', mentioned_count: 3, unread_count: 1 },
        { row_id: 'row-1', field_id: 'fld-b', mentioned_count: 2, unread_count: 2 },
        { row_id: 'row-2', field_id: null, mentioned_count: 1, unread_count: 0 },
      ])

      const result = await service.getMentionSummary('sheet-1', 'user-viewer')

      expect(result.unresolvedMentionCount).toBe(6)
      expect(result.unreadMentionCount).toBe(3)
      expect(result.mentionedRecordCount).toBe(2)
      expect(result.unreadRecordCount).toBe(1)

      const row1 = result.items.find((item) => item.rowId === 'row-1')
      expect(row1).toBeDefined()
      expect(row1!.mentionedCount).toBe(5)
      expect(row1!.unreadCount).toBe(3)
      expect(row1!.mentionedFieldIds).toEqual(['fld-a', 'fld-b'])
    })
  })

  // ── getCommentPresenceSummary (optimized single query) ────────────────

  describe('getCommentPresenceSummary', () => {
    it('returns aggregated counts from single query', async () => {
      pushExec([
        { row_id: 'row-1', field_id: 'fld-a', comment_count: 3, mentioned_count: 1 },
        { row_id: 'row-1', field_id: null, comment_count: 2, mentioned_count: 0 },
        { row_id: 'row-2', field_id: 'fld-b', comment_count: 1, mentioned_count: 1 },
      ])

      const result = await service.getCommentPresenceSummary('sheet-1', undefined, 'user-viewer')

      expect(result.items).toHaveLength(2)
      const row1 = result.items.find((item) => item.rowId === 'row-1')
      expect(row1).toBeDefined()
      expect(row1!.unresolvedCount).toBe(5)
      expect(row1!.fieldCounts).toEqual({ 'fld-a': 3 })
      expect(row1!.mentionedCount).toBe(1)
      expect(row1!.mentionedFieldCounts).toEqual({ 'fld-a': 1 })

      const row2 = result.items.find((item) => item.rowId === 'row-2')
      expect(row2).toBeDefined()
      expect(row2!.unresolvedCount).toBe(1)
      expect(row2!.mentionedCount).toBe(1)
      expect(row2!.mentionedFieldCounts).toEqual({ 'fld-b': 1 })
    })

    it('returns zero mentioned counts when no mentionUserId', async () => {
      pushExec([
        { row_id: 'row-1', field_id: null, comment_count: 4, mentioned_count: 0 },
      ])

      const result = await service.getCommentPresenceSummary('sheet-1')

      expect(result.items).toHaveLength(1)
      expect(result.items[0].mentionedCount).toBe(0)
      expect(result.items[0].unresolvedCount).toBe(4)
    })

    it('respects rowIds filter ordering', async () => {
      pushExec([
        { row_id: 'row-b', field_id: null, comment_count: 1, mentioned_count: 0 },
        { row_id: 'row-a', field_id: null, comment_count: 2, mentioned_count: 0 },
      ])

      const result = await service.getCommentPresenceSummary('sheet-1', ['row-a', 'row-b'])

      expect(result.items[0].rowId).toBe('row-a')
      expect(result.items[1].rowId).toBe('row-b')
    })
  })

  // ── markAllCommentsRead ───────────────────────────────────────────────

  describe('markAllCommentsRead', () => {
    it('returns 0 when there are no unread comments', async () => {
      // unread query returns empty list
      pushExec([])

      const count = await service.markAllCommentsRead('sheet-1', 'user-1')

      expect(count).toBe(0)
    })

    it('returns 0 for empty spreadsheetId', async () => {
      const count = await service.markAllCommentsRead('', 'user-1')
      expect(count).toBe(0)
    })

    it('returns 0 for empty userId', async () => {
      const count = await service.markAllCommentsRead('sheet-1', '')
      expect(count).toBe(0)
    })

    it('inserts read records and returns the count', async () => {
      // unread query: two unread comments
      pushExec([{ id: 'cmt_a' }, { id: 'cmt_b' }])
      // batch insert execute
      pushExec([])

      const count = await service.markAllCommentsRead('sheet-1', 'user-1')

      expect(count).toBe(2)
    })

    it('trims whitespace from userId and spreadsheetId', async () => {
      pushExec([{ id: 'cmt_c' }])
      pushExec([])

      const count = await service.markAllCommentsRead('  sheet-1  ', '  user-1  ')

      expect(count).toBe(1)
    })
  })

  // ── getCommentPresenceSummaryWithViewers ──────────────────────────────

  describe('getCommentPresenceSummaryWithViewers', () => {
    it('returns base presence without viewers when includeViewers is false', async () => {
      pushExec([
        { row_id: 'row-1', field_id: null, comment_count: 2, mentioned_count: 0 },
      ])

      const result = await service.getCommentPresenceSummaryWithViewers('sheet-1', undefined, undefined, false)

      expect(result.items).toHaveLength(1)
      expect(result.viewers).toBeUndefined()
    })

    it('returns base presence without viewers when includeViewers is omitted', async () => {
      pushExec([
        { row_id: 'row-1', field_id: null, comment_count: 1, mentioned_count: 0 },
      ])

      const result = await service.getCommentPresenceSummaryWithViewers('sheet-1')

      expect(result.viewers).toBeUndefined()
    })

    it('appends viewers array when includeViewers is true', async () => {
      // Mock getRoomMembers to return user list
      mockCollabService.getRoomMembers = vi.fn().mockResolvedValue(['user-alice', 'user-bob'])

      pushExec([
        { row_id: 'row-1', field_id: null, comment_count: 3, mentioned_count: 1 },
      ])

      const result = await service.getCommentPresenceSummaryWithViewers('sheet-1', undefined, 'user-alice', true)

      expect(result.viewers).toBeDefined()
      expect(result.viewers).toHaveLength(2)
      expect(result.viewers!.map((v) => v.userId)).toContain('user-alice')
      expect(result.viewers!.map((v) => v.userId)).toContain('user-bob')
    })

    it('returns empty viewers array when room has no members', async () => {
      mockCollabService.getRoomMembers = vi.fn().mockResolvedValue([])

      pushExec([])

      const result = await service.getCommentPresenceSummaryWithViewers('sheet-1', undefined, undefined, true)

      expect(result.viewers).toBeDefined()
      expect(result.viewers).toHaveLength(0)
    })
  })

  // ── listMentionCandidates ─────────────────────────────────────────────

  describe('listMentionCandidates', () => {
    it('returns empty for blank spreadsheetId', async () => {
      const result = await service.listMentionCandidates('  ')

      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
    })

    it('maps user rows to candidate shape', async () => {
      // total count
      pushTakeFirst({ c: 1 })
      // row data
      pushExec([{ id: 'user-1', name: 'Alice', email: 'alice@example.com' }])

      const result = await service.listMentionCandidates('sheet-1', { q: 'alic', limit: 10 })

      expect(result.total).toBe(1)
      expect(result.items).toHaveLength(1)
      expect(result.items[0].id).toBe('user-1')
      expect(result.items[0].label).toBe('Alice')
      expect(result.items[0].subtitle).toBe('alice@example.com')
    })

    it('uses email as label when name is missing', async () => {
      pushTakeFirst({ c: 1 })
      pushExec([{ id: 'user-2', name: null, email: 'bob@example.com' }])

      const result = await service.listMentionCandidates('sheet-1')

      expect(result.items[0].label).toBe('bob@example.com')
      expect(result.items[0].subtitle).toBeUndefined()
    })
  })
})
