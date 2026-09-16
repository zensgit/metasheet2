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
  getCommentInboxSubscriberIds: vi.fn(() => ['user-inbox']),
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

import {
  CommentService,
  CommentValidationError,
  CommentNotFoundError,
  CommentAccessError,
  CommentConflictError,
  REPLY_PARENT_OUTSIDE_THREAD_MESSAGE,
} from '../../src/services/CommentService'
import type { CollabService } from '../../src/services/CollabService'
import type { CommentInboxScope } from '../../src/di/identifiers'

/** #5831 part B: the cross-sheet aggregates need the route's scope; these fixtures live on sheet-1. */
const INBOX_SCOPE: CommentInboxScope = { sheetIds: ['sheet-1'], deniedRows: [] }

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
    // Canonical container/target columns (mirror spreadsheet_id/row_id/field_id).
    // The mapper must surface these as containerId/targetId/targetFieldId — keeping
    // them on the fixture prevents the fixture-vs-wire drift that hid the read field-drop.
    container_id: 'sheet-1',
    target_id: 'row-1',
    target_field_id: null,
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
    mockCollabService.getCommentInboxSubscriberIds.mockReturnValue(['user-inbox'])
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
      // Fixture-vs-wire guard: the mapper must surface the canonical container/target
      // columns (regression lock for the read field-drop fixed in this PR).
      expect(comment.containerId).toBe('sheet-1')
      expect(comment.targetId).toBe('row-1')
      expect(comment.targetFieldId).toBeNull()
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

      const result = await service.getInbox('user-viewer', undefined, INBOX_SCOPE)

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

      const result = await service.getInbox('user-viewer', undefined, INBOX_SCOPE)

      expect(result.total).toBe(2)
      expect(result.items[0].unread).toBe(true)
      expect(result.items[0].mentioned).toBe(true)
      expect(result.items[1].unread).toBe(false)
      expect(result.items[1].mentioned).toBe(true)
    })

    it("excludes author's own comments (author_id != userId filter)", async () => {
      pushTakeFirst({ c: 0 })
      pushExec([])

      const result = await service.getInbox('user-author', undefined, INBOX_SCOPE)

      expect(result.total).toBe(0)
      expect(result.items).toHaveLength(0)
    })
  })

  // ── getUnreadCount ────────────────────────────────────────────────────

  describe('getUnreadCount', () => {
    it('counts only comments where user has no read record', async () => {
      pushTakeFirst({ c: 5 })

      const count = await service.getUnreadCount('user-viewer', INBOX_SCOPE)

      expect(count).toBe(5)
    })

    it("excludes user's own comments from unread count", async () => {
      pushTakeFirst({ c: 0 })

      const count = await service.getUnreadCount('user-author', INBOX_SCOPE)

      expect(count).toBe(0)
    })

    it('returns 0 when no unread comments', async () => {
      pushTakeFirst({ c: 0 })

      const count = await service.getUnreadCount('user-1', INBOX_SCOPE)

      expect(count).toBe(0)
    })

    it('returns 0 when query returns undefined', async () => {
      pushTakeFirst(undefined)

      const count = await service.getUnreadCount('user-1', INBOX_SCOPE)

      expect(count).toBe(0)
    })
  })

  // ── #5831 part B: the inbox scope ─────────────────────────────────────

  describe('cross-sheet aggregates need an admitted scope (#5831 part B)', () => {
    async function selectFromMock() {
      const { db } = await import('../../src/db/db') as unknown as { db: { selectFrom: ReturnType<typeof vi.fn> } }
      return db.selectFrom
    }

    it('a missing, empty or malformed scope answers empty WITHOUT a query (never "every sheet")', async () => {
      const selectFrom = await selectFromMock()
      selectFrom.mockClear()
      const nothing: unknown[] = [
        undefined,
        { sheetIds: [], deniedRows: [] },
        { sheetIds: [''], deniedRows: [] },
        { sheetIds: 'sheet-1', deniedRows: [] },
        { deniedRows: [{ spreadsheetId: 'sheet-1', rowId: 'row-1' }] },
      ]
      for (const scope of nothing) {
        await expect(service.getInbox('user-viewer', { limit: 5, offset: 0 }, scope as never)).resolves.toEqual({ items: [], total: 0 })
        await expect(service.getUnreadSummary('user-viewer', scope as never)).resolves.toEqual({ unreadCount: 0, mentionUnreadCount: 0 })
        await expect(service.getUnreadCount('user-viewer', scope as never)).resolves.toBe(0)
      }
      // A blank user never queries either.
      await expect(service.getInbox('  ', undefined, INBOX_SCOPE)).resolves.toEqual({ items: [], total: 0 })
      await expect(service.getUnreadSummary('', INBOX_SCOPE)).resolves.toEqual({ unreadCount: 0, mentionUnreadCount: 0 })
      expect(selectFrom).not.toHaveBeenCalled()
    })

    it('an admitted scope is put on every aggregate query (COUNT and page)', async () => {
      const selectFrom = await selectFromMock()
      selectFrom.mockClear()
      pushTakeFirst({ c: 0 })
      pushExec([])
      await service.getInbox('user-viewer', { limit: 5, offset: 0 }, INBOX_SCOPE)
      pushTakeFirst({ unread_count: 0, mention_unread_count: 0 })
      await service.getUnreadSummary('user-viewer', INBOX_SCOPE)
      pushTakeFirst({ c: 0 })
      await service.getUnreadCount('user-viewer', INBOX_SCOPE)
      const chains = selectFrom.mock.results.map((r) => r.value as Record<string, ReturnType<typeof vi.fn>>)
      expect(chains).toHaveLength(4)
      // author filter + inbox/unread predicate + the scope predicate, on each query
      for (const chain of chains) expect(chain.where).toHaveBeenCalledTimes(3)
    })

    it('candidate listers: ids only, grouped, and no query without a user or sheets', async () => {
      const selectFrom = await selectFromMock()
      selectFrom.mockClear()
      await expect(service.listInboxCandidateSheetIds(' ')).resolves.toEqual([])
      await expect(service.listInboxCandidateRowIds('user-viewer', [])).resolves.toEqual(new Map())
      await expect(service.listInboxCandidateRowIds('', ['sheet-1'])).resolves.toEqual(new Map())
      expect(selectFrom).not.toHaveBeenCalled()

      pushExec([{ spreadsheet_id: 'sheet-1' }, { spreadsheet_id: 'sheet-2' }, { spreadsheet_id: null }])
      await expect(service.listInboxCandidateSheetIds('user-viewer')).resolves.toEqual(['sheet-1', 'sheet-2'])
      pushExec([
        { spreadsheet_id: 'sheet-1', row_id: 'row-1' },
        { spreadsheet_id: 'sheet-1', row_id: 'row-2' },
        { spreadsheet_id: 'sheet-2', row_id: 'row-9' },
        { spreadsheet_id: 'sheet-2', row_id: '' },
      ])
      await expect(service.listInboxCandidateRowIds('user-viewer', ['sheet-1', 'sheet-2', 'sheet-1'])).resolves.toEqual(new Map([
        ['sheet-1', ['row-1', 'row-2']],
        ['sheet-2', ['row-9']],
      ]))
      const [sheets, rows] = selectFrom.mock.results.map((r) => r.value as Record<string, ReturnType<typeof vi.fn>>)
      expect(sheets!.select).toHaveBeenCalledWith('c.spreadsheet_id')
      expect(sheets!.groupBy).toHaveBeenCalledWith('c.spreadsheet_id')
      expect(rows!.select).toHaveBeenCalledWith(['c.spreadsheet_id', 'c.row_id'])
      expect(rows!.groupBy).toHaveBeenCalledWith(['c.spreadsheet_id', 'c.row_id'])
      expect(rows!.selectAll).not.toHaveBeenCalled()
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

    it('only emits comment:activity to inbox subscribers that can read the target record', async () => {
      mockCollabService.getCommentInboxSubscriberIds.mockReturnValue(['user-allowed', 'user-denied'])
      service.setCommentTargetReadChecker(async ({ userId }) => userId === 'user-allowed')
      const row = makeCommentRow({ id: 'cmt_del_acl', author_id: 'user-author' })
      pushTakeFirst(row)
      pushTakeFirst(undefined)

      await service.deleteComment('cmt_del_acl', 'user-author')

      const activityCalls = mockCollabService.broadcastTo.mock.calls.filter(
        (call: unknown[]) => call[1] === 'comment:activity',
      )
      expect(activityCalls).toHaveLength(1)
      expect(activityCalls[0][0]).toBe('comments-inbox:user-allowed')
      expect(JSON.stringify(activityCalls)).not.toContain('user-denied')
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

    it('does not send a new mention notification when the mentioned user cannot read the target row', async () => {
      service.setCommentTargetReadChecker(async ({ userId }) => userId !== 'user-denied')
      const existingRow = makeCommentRow({
        id: 'cmt_up_denied',
        author_id: 'user-author',
        mentions: JSON.stringify([]),
      })
      const updatedRow = makeCommentRow({
        id: 'cmt_up_denied',
        author_id: 'user-author',
        row_id: 'row-secret',
        target_id: 'row-secret',
        content: '@[Denied](user-denied)',
        mentions: JSON.stringify(['user-denied']),
      })

      pushTakeFirst(existingRow) // getRequiredCommentRow
      pushExec([])               // updateTable execute
      pushTakeFirst(updatedRow)  // getComment reload

      await service.updateComment('cmt_up_denied', 'user-author', {
        content: '@[Denied](user-denied)',
      })

      const sendToCalls = mockCollabService.sendTo.mock.calls.filter(
        (call: unknown[]) => call[1] === 'comment:mention',
      )
      expect(sendToCalls.map((call: unknown[]) => call[0])).not.toContain('user-denied')
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

  // ── getCommentAddress (#5831) ─────────────────────────────────────────

  describe('getCommentAddress', () => {
    async function lastSelectChain() {
      const { db } = await import('../../src/db/db') as unknown as { db: { selectFrom: ReturnType<typeof vi.fn> } }
      const calls = db.selectFrom.mock.calls
      const results = db.selectFrom.mock.results
      return { table: calls[calls.length - 1]?.[0], chain: results[results.length - 1]?.value as Record<string, ReturnType<typeof vi.fn>> }
    }

    it('returns only the sheet and row of the comment, read by id', async () => {
      pushTakeFirst({ spreadsheet_id: 'sheet-9', row_id: 'row-9' })

      await expect(service.getCommentAddress('cmt_addr')).resolves.toEqual({
        spreadsheetId: 'sheet-9',
        rowId: 'row-9',
      })

      const { table, chain } = await lastSelectChain()
      expect(table).toBe('meta_comments')
      expect(chain.select).toHaveBeenCalledWith(['spreadsheet_id', 'row_id'])
      expect(chain.selectAll).not.toHaveBeenCalled()
      expect(chain.where).toHaveBeenCalledTimes(1)
      expect(chain.where).toHaveBeenCalledWith('id', '=', 'cmt_addr')
    })

    it('returns null for an unknown comment id', async () => {
      await expect(service.getCommentAddress('cmt_missing')).resolves.toBeNull()
    })
  })

  // ── createComment: reply parent (#5831) ───────────────────────────────

  describe('createComment reply parent gives no existence answer outside the thread (#5831)', () => {
    const reply = (parentId: string) => service.createComment({
      spreadsheetId: 'sheet-1',
      rowId: 'row-1',
      content: 'a reply',
      authorId: 'user-author',
      parentId,
    })

    async function insertCalls(): Promise<number> {
      const { db } = await import('../../src/db/db') as unknown as { db: { insertInto: ReturnType<typeof vi.fn> } }
      return db.insertInto.mock.calls.length
    }

    it('an unknown parent and a parent on another sheet or row — root or reply — all get the same answer', async () => {
      const outside = [
        undefined, // unknown id
        makeCommentRow({ id: 'cmt_p_sheet', spreadsheet_id: 'sheet-other' }),
        makeCommentRow({ id: 'cmt_p_row', row_id: 'row-other' }),
        // A REPLY outside the thread must not answer "Replying to replies" (that would reveal it).
        makeCommentRow({ id: 'cmt_p_sheet_reply', spreadsheet_id: 'sheet-other', parent_id: 'cmt_root_elsewhere' }),
        makeCommentRow({ id: 'cmt_p_row_reply', row_id: 'row-other', parent_id: 'cmt_root_elsewhere' }),
      ]
      const answers: string[] = []
      for (const parent of outside) {
        pushTakeFirst(parent)
        const error = await reply('cmt_p_any').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(CommentValidationError)
        answers.push((error as Error).message)
      }
      expect(answers).toEqual(outside.map(() => REPLY_PARENT_OUTSIDE_THREAD_MESSAGE))
      // Existing clients match on this phrase (tests/integration/comments.api.test.ts).
      expect(REPLY_PARENT_OUTSIDE_THREAD_MESSAGE).toContain('same record thread')
      expect(await insertCalls()).toBe(0)
    })

    it('inside the caller’s own thread a reply to a reply is still refused as such', async () => {
      pushTakeFirst(makeCommentRow({ id: 'cmt_p_nested', parent_id: 'cmt_root' }))
      await expect(reply('cmt_p_nested')).rejects.toThrow('Replying to replies is not supported')
      expect(await insertCalls()).toBe(0)
    })

    it('a root comment in the same thread is a valid parent', async () => {
      pushTakeFirst(makeCommentRow({ id: 'cmt_root' })) // parent lookup
      pushExec([]) // insert
      pushTakeFirst(makeCommentRow({ id: 'cmt_reply', parent_id: 'cmt_root' })) // reload
      pushExec([]) // markCommentRead

      const comment = await reply('cmt_root')
      expect(comment.id).toBe('cmt_reply')
      expect(await insertCalls()).toBeGreaterThan(0)
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

    // #5808: an old comment whose mentions are not `@[label](id)` tokens in its body must still show
    // (and keep) those mentions when its author edits it. The list names them — for the caller's OWN
    // comments only, active users only, one batched lookup, bounded per page. Fake ids/emails only.
    describe('#5808 edit-time mention labels', () => {
      type Chain = Record<string, ReturnType<typeof vi.fn>>
      async function usersChains(): Promise<Chain[]> {
        const { db } = await import('../../src/db/db') as unknown as { db: { selectFrom: ReturnType<typeof vi.fn> } }
        return db.selectFrom.mock.calls
          .map((args, index) => ({ table: args[0], chain: db.selectFrom.mock.results[index]?.value as Chain }))
          .filter((entry) => entry.table === 'users')
          .map((entry) => entry.chain)
      }

      function queuePage(rows: Array<Record<string, unknown>>, userRows?: Array<Record<string, unknown>>) {
        pushTakeFirst({ c: rows.length })
        pushExec(rows)
        pushExec([]) // reactions
        if (userRows) pushExec(userRows)
      }

      it("labels only the caller's own comments, each with its own mentions, via ONE batched active-user query", async () => {
        queuePage([
          makeCommentRow({ id: 'cmt_own_1', author_id: 'user-author', mentions: JSON.stringify(['u-alpha', 'u-beta']) }),
          makeCommentRow({ id: 'cmt_other', author_id: 'user-other', mentions: JSON.stringify(['u-zeta']) }),
          makeCommentRow({ id: 'cmt_own_2', author_id: 'user-author', mentions: JSON.stringify(['u-beta', 'u-gone', 'u-blank']) }),
        ], [
          { id: 'u-alpha', name: 'Fake Alpha', email: 'alpha@example.invalid' },
          { id: 'u-beta', name: null, email: 'beta@example.invalid' },
          // not asked for (only on someone else's comment) — a stray row must never be attached
          { id: 'u-zeta', name: 'Fake Zeta', email: 'zeta@example.invalid' },
          // a row with neither a name nor an email yields no label (never the raw id)
          { id: 'u-blank', name: '  ', email: '' },
          // u-gone: no row (deactivated or deleted) ⇒ deterministically absent
        ])

        const { items } = await service.getComments('sheet-1', { mentionLabelsAuthorId: 'user-author' })
        const byId = new Map(items.map((item) => [item.id, item]))

        expect(byId.get('cmt_own_1')!.mentionLabels).toEqual({ 'u-alpha': 'Fake Alpha', 'u-beta': 'beta@example.invalid' })
        expect(byId.get('cmt_own_2')!.mentionLabels).toEqual({ 'u-beta': 'beta@example.invalid' })
        expect(byId.get('cmt_other')!.mentionLabels).toBeUndefined()
        // labels never rewrite the mention list itself
        expect(byId.get('cmt_own_2')!.mentions).toEqual(['u-beta', 'u-gone', 'u-blank'])

        const chains = await usersChains()
        expect(chains).toHaveLength(1)
        const [chain] = chains
        expect(chain.select.mock.calls).toEqual([[['id', 'name', 'email']]])
        expect(chain.where.mock.calls).toEqual([
          ['id', 'in', ['u-alpha', 'u-beta', 'u-gone', 'u-blank']],
          ['is_active', '=', true],
        ])
        expect(chain.execute).toHaveBeenCalledTimes(1)
      })

      it("issues no user lookup without an author, or when the author's comments mention nobody", async () => {
        queuePage([makeCommentRow({ id: 'cmt_a', author_id: 'user-author', mentions: JSON.stringify(['u-alpha']) })])
        const unlabelled = await service.getComments('sheet-1')
        expect(unlabelled.items[0].mentionLabels).toBeUndefined()

        queuePage([
          makeCommentRow({ id: 'cmt_b', author_id: 'user-author', mentions: '[]' }),
          makeCommentRow({ id: 'cmt_c', author_id: 'user-other', mentions: JSON.stringify(['u-alpha']) }),
        ])
        const nobody = await service.getComments('sheet-1', { mentionLabelsAuthorId: 'user-author' })
        expect(nobody.items[0].mentionLabels).toEqual({})
        expect(nobody.items[1].mentionLabels).toBeUndefined()

        expect(await usersChains()).toHaveLength(0)
      })

      it('asks for at most MENTION_LABELS_MAX_IDS distinct ids per page (first appearance order)', async () => {
        const { MENTION_LABELS_MAX_IDS } = await import('../../src/services/comment-mention-bounds')
        expect(MENTION_LABELS_MAX_IDS).toBe(50)
        const many = Array.from({ length: 120 }, (_unused, index) => `u-${index + 1}`)
        queuePage([
          makeCommentRow({ id: 'cmt_many_1', author_id: 'user-author', mentions: JSON.stringify(many.slice(0, 30)) }),
          makeCommentRow({ id: 'cmt_many_2', author_id: 'user-author', mentions: JSON.stringify(many) }),
        ], many.map((id) => ({ id, name: `Fake ${id}`, email: `${id}@example.invalid` })))

        const { items } = await service.getComments('sheet-1', { mentionLabelsAuthorId: 'user-author' })

        const [chain] = await usersChains()
        const asked = chain.where.mock.calls.find((args) => args[0] === 'id')![2] as string[]
        expect(asked).toEqual(many.slice(0, 50))
        // even though the (mocked) DB returned every row, nothing past the ceiling gets a label
        expect(Object.keys(items[1].mentionLabels!)).toEqual(many.slice(0, 50))
        expect(items[1].mentions).toHaveLength(120)
      })
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
      // #5795: no count of any kind is returned any more.
      expect(result).not.toHaveProperty('total')
    })

    it('maps user rows to candidate shape', async () => {
      // #5795: no COUNT query any more — only the row query.
      pushExec([{ id: 'user-1', name: 'Alice', email: 'alice@example.com' }])

      const result = await service.listMentionCandidates('sheet-1', { q: 'alic', limit: 10 })

      expect(result).not.toHaveProperty('total')
      expect(result.items).toHaveLength(1)
      expect(result.items[0].id).toBe('user-1')
      expect(result.items[0].label).toBe('Alice')
      expect(result.items[0].subtitle).toBe('alice@example.com')
    })

    it('uses email as label when name is missing', async () => {
      pushExec([{ id: 'user-2', name: null, email: 'bob@example.com' }])

      // #5795: a term is required, so this mapping case supplies one.
      const result = await service.listMentionCandidates('sheet-1', { q: 'bob' })

      expect(result.items[0].label).toBe('bob@example.com')
      expect(result.items[0].subtitle).toBeUndefined()
    })

    it('#5795: a term-less call returns nothing and issues no query', async () => {
      pushExec([{ id: 'user-3', name: 'Fake Person', email: 'fake.person@example.invalid' }])

      const result = await service.listMentionCandidates('sheet-1')
      const whitespace = await service.listMentionCandidates('sheet-1', { q: '   ', limit: 100 })

      expect(result.items).toEqual([])
      expect(whitespace.items).toEqual([])
      // the queued row was never consumed ⇒ no row query ran
      expect(queueExec).toHaveLength(1)
      const { db } = await import('../../src/db/db') as unknown as { db: { selectFrom: ReturnType<typeof vi.fn> } }
      expect(db.selectFrom).not.toHaveBeenCalled()
    })

    describe('#5795 SQL-level bounds (what the DB is ASKED for)', () => {
      type Chain = Record<string, ReturnType<typeof vi.fn>>
      async function lastUsersChain(): Promise<Chain> {
        const { db } = await import('../../src/db/db') as unknown as { db: { selectFrom: ReturnType<typeof vi.fn> } }
        const results = db.selectFrom.mock.results
        expect(results.length).toBeGreaterThan(0)
        return results[results.length - 1].value as Chain
      }
      /** Evaluates the `where((eb) => eb.or([...]))` callback and returns the bound LIKE parameters. */
      function likeParams(chain: Chain): unknown[] {
        const callback = chain.where.mock.calls.map((args) => args[0]).find((arg) => typeof arg === 'function') as
          | ((eb: { or: (xs: unknown[]) => unknown[] }) => unknown[])
          | undefined
        expect(callback).toBeTypeOf('function')
        const fragments = callback!({ or: (xs) => xs })
        return fragments.flatMap((fragment) => {
          const node = (fragment as { toOperationNode: () => { parameters: Array<{ value: unknown }> } }).toOperationNode()
          return node.parameters.map((p) => p.value)
        })
      }

      it('caps the SQL LIMIT at ceiling + 1 no matter what the caller asks for', async () => {
        pushExec([])
        await service.listMentionCandidates('sheet-1', { q: 'fake', limit: 100000 })
        const chain = await lastUsersChain()
        expect(chain.limit).toHaveBeenCalledTimes(1)
        expect(chain.limit.mock.calls[0][0]).toBe(51)
      })

      it('defaults to the ceiling (50) and never below 1', async () => {
        pushExec([])
        await service.listMentionCandidates('sheet-1', { q: 'fake' })
        expect((await lastUsersChain()).limit.mock.calls[0][0]).toBe(50)

        pushExec([])
        await service.listMentionCandidates('sheet-1', { q: 'fake', limit: 0 })
        expect((await lastUsersChain()).limit.mock.calls[0][0]).toBe(1)

        pushExec([])
        await service.listMentionCandidates('sheet-1', { q: 'fake', limit: Number.NaN })
        expect((await lastUsersChain()).limit.mock.calls[0][0]).toBe(50)
      })

      it('issues NO count query (the deployment-wide total is gone)', async () => {
        pushTakeFirst({ c: 4321 })
        pushExec([{ id: 'user-1', name: 'Fake Person', email: 'fake@example.invalid' }])

        const result = await service.listMentionCandidates('sheet-1', { q: 'fake' })

        expect(result).not.toHaveProperty('total')
        expect(JSON.stringify(result)).not.toContain('4321')
        const chain = await lastUsersChain()
        expect(chain.executeTakeFirst).not.toHaveBeenCalled()
        // the only select is the row projection, never an aggregate builder callback
        expect(chain.select.mock.calls).toEqual([[['id', 'name', 'email']]])
        // the queued count row was never consumed
        expect(queueTakeFirst).toHaveLength(1)
      })

      it('always applies the term predicate, lower-cased and trimmed', async () => {
        pushExec([])
        await service.listMentionCandidates('sheet-1', { q: '  FaKe  ' })
        const params = likeParams(await lastUsersChain())
        expect(params).toEqual(['%fake%', '%fake%', '%fake%'])
      })

      it('escapes LIKE metacharacters so a typed `%` / `_` searches literally (search correctness)', async () => {
        pushExec([])
        await service.listMentionCandidates('sheet-1', { q: '%' })
        expect(likeParams(await lastUsersChain())).toEqual(['%\\%%', '%\\%%', '%\\%%'])

        pushExec([])
        await service.listMentionCandidates('sheet-1', { q: 'a_b\\' })
        expect(likeParams(await lastUsersChain())).toEqual(['%a\\_b\\\\%', '%a\\_b\\\\%', '%a\\_b\\\\%'])
      })

      // Refuter round (#5795): escaping is NOT what bounds a deliberate caller. `-` (in every UUID-shaped
      // id) and `@` (in every email) are ordinary characters that reach the name/email/id predicate as-is
      // and match every active user; the SQL LIMIT is the only thing standing between such a term and the
      // whole set, so it must apply to exactly these terms too.
      it('a term every row contains (`-`, `@`) is not narrowed by escaping — the LIMIT still caps it', async () => {
        for (const universal of ['-', '@']) {
          pushExec([])
          await service.listMentionCandidates('sheet-1', { q: universal, limit: 100000 })
          const chain = await lastUsersChain()
          expect(likeParams(chain)).toEqual([`%${universal}%`, `%${universal}%`, `%${universal}%`])
          expect(chain.limit.mock.calls[0][0]).toBe(51)
        }
      })

      // #5809 — the legacy person importer's email-owner lookup. It must be EQUALITY on the trimmed,
      // lower-cased email only: a substring page of 50 can be filled by `wangli@…` before `li@…`.
      describe('#5809 match: exact-email', () => {
        function whereFragments(chain: Chain): Array<{ text: string; params: unknown[] }> {
          const callback = chain.where.mock.calls.map((args) => args[0]).find((arg) => typeof arg === 'function') as
            | ((eb: { or: (xs: unknown[]) => unknown[] }) => unknown[])
            | undefined
          expect(callback).toBeTypeOf('function')
          return callback!({ or: (xs) => xs }).map((fragment) => {
            const node = (fragment as {
              toOperationNode: () => { sqlFragments: string[]; parameters: Array<{ value: unknown }> }
            }).toOperationNode()
            return { text: node.sqlFragments.join('?'), params: node.parameters.map((p) => p.value) }
          })
        }

        it('swaps the three LIKE arms for ONE trimmed email equality, with the JS trim() set bound', async () => {
          const { JS_TRIM_WHITESPACE } = await import('../../src/utils/js-trim-whitespace')
          pushExec([])
          await service.listMentionCandidates('sheet-1', { q: '  Fake.Person@Example.Invalid ', limit: 100000, match: 'exact-email' })
          const chain = await lastUsersChain()
          const fragments = whereFragments(chain)
          expect(fragments).toEqual([
            { text: "lower(btrim(coalesce(email, ''), ?)) = ?", params: [JS_TRIM_WHITESPACE, 'fake.person@example.invalid'] },
          ])
          expect(fragments[0].text).not.toMatch(/like/i)
          // Same ceiling and same active-only filter as the substring search.
          expect(chain.limit.mock.calls[0][0]).toBe(51)
          expect(chain.where.mock.calls[0]).toEqual(['is_active', '=', true])
        })

        it('still requires a term (no query for a blank one)', async () => {
          pushExec([{ id: 'user-9', name: 'Fake', email: 'fake@example.invalid' }])
          const result = await service.listMentionCandidates('sheet-1', { q: '   ', match: 'exact-email' })
          expect(result.items).toEqual([])
          const { db } = await import('../../src/db/db') as unknown as { db: { selectFrom: ReturnType<typeof vi.fn> } }
          expect(db.selectFrom).not.toHaveBeenCalled()
        })

        it('any other match value is the substring search, unchanged', async () => {
          pushExec([])
          await service.listMentionCandidates('sheet-1', { q: 'fake', match: 'exact' as unknown as 'exact-email' })
          expect(likeParams(await lastUsersChain())).toEqual(['%fake%', '%fake%', '%fake%'])
        })
      })
    })
  })
})
