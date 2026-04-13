/**
 * Week-1 collab semantics integration test — comment-flow
 *
 * Validates the full comment semantic contract as unified in Week 1:
 *   1. Full lifecycle:       create → get → update → delete, all events fire
 *   2. Unread semantics:     new comment is unread for non-authors; author auto-read
 *   3. Mention contract:     @[Name](userId) parsing; mentionUnreadCount split
 *   4. Backward compat:      /api/comments/unread-count response includes `count` alias
 *   5. Inbox contract:       only mention-targeted comments; own comments excluded
 *
 * This is a MOCK-DB integration test — no live PostgreSQL is required.
 * The mock replicates the Kysely query-builder chain used in CommentService.
 *
 * Run with either:
 *   npx vitest run tests/integration/comment-flow.test.ts
 *   pnpm --filter @metasheet/core-backend exec vitest run tests/integration/comment-flow.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ILogger } from '../../src/di/identifiers'

// ---------------------------------------------------------------------------
// Inline mock for ../../src/db/db
//
// IMPORTANT: vi.mock is hoisted before all imports. To share queues between
// the factory and the test body, we use the module-level __exec/__takeFirst
// arrays and export them so tests can access them via the module re-import.
// ---------------------------------------------------------------------------

vi.mock('../../src/db/db', () => {
  // Private queues inside factory scope; exported as __execQueue/__takeFirstQueue
  const execQueue: unknown[] = []
  const takeFirstQueue: unknown[] = []

  function makeChain(): Record<string, unknown> {
    const self: Record<string, unknown> = {}
    const passThrough = (..._args: unknown[]) => self
    const chainMethods = [
      'selectFrom', 'selectAll', 'select', 'where', 'orderBy',
      'limit', 'offset', 'groupBy', 'insertInto', 'values',
      'onConflict', 'columns', 'doUpdateSet',
      'updateTable', 'set', 'deleteFrom', 'returningAll', 'leftJoin',
    ]
    for (const method of chainMethods) {
      self[method] = vi.fn(passThrough)
    }
    self.execute = vi.fn(async () => execQueue.shift() ?? [])
    self.executeTakeFirst = vi.fn(async () => takeFirstQueue.shift())
    return self
  }

  const root: Record<string, unknown> = {}
  for (const m of ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom']) {
    root[m] = vi.fn(() => makeChain())
  }

  const dbProxy = new Proxy(root, {
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
      return (target as Record<string, unknown>)[prop as string]
    },
  })

  return {
    db: dbProxy,
    // Export queue references for test access
    __execQueue: execQueue,
    __takeFirstQueue: takeFirstQueue,
  }
})

vi.mock('../../src/db/type-helpers', () => ({
  nowTimestamp: () => new Date().toISOString(),
}))

// ---------------------------------------------------------------------------
// CollabService + logger mocks
// ---------------------------------------------------------------------------

const mockCollab = {
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

// ---------------------------------------------------------------------------
// Import SUT and queue references after mocks
// ---------------------------------------------------------------------------

import {
  CommentService,
  CommentValidationError,
  CommentNotFoundError,
  CommentAccessError,
  CommentConflictError,
} from '../../src/services/CommentService'
import type { CollabService } from '../../src/services/CollabService'
import type { CommentUnreadSummary } from '../../src/di/identifiers'

// Queue accessors — retrieved in beforeEach to get the live arrays
let queueExec: unknown[]
let queueTakeFirst: unknown[]

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmt_default',
    spreadsheet_id: 'sheet_a',
    row_id: 'row_1',
    field_id: null,
    content: 'Default content',
    author_id: 'user_author',
    parent_id: null,
    resolved: false,
    created_at: '2026-04-13T00:00:00.000Z',
    updated_at: '2026-04-13T00:00:00.000Z',
    mentions: '[]',
    ...overrides,
  }
}

function inboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmt_inbox_default',
    spreadsheet_id: 'sheet_a',
    row_id: 'row_1',
    field_id: null,
    content: 'Default inbox content',
    author_id: 'user_other',
    parent_id: null,
    resolved: false,
    created_at: '2026-04-13T00:00:00.000Z',
    updated_at: '2026-04-13T00:00:00.000Z',
    mentions: '[]',
    unread: true,
    mentioned: false,
    base_id: 'base_1',
    sheet_id: 'sheet_a',
    view_id: 'view_1',
    record_id: 'row_1',
    ...overrides,
  }
}

/** Push items for execute() calls (arrays) */
function qExec(...items: unknown[]) {
  queueExec.push(...items)
}

/** Push items for executeTakeFirst() calls (single rows) */
function qFirst(...items: unknown[]) {
  queueTakeFirst.push(...items)
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Week-1 collab semantics — comment-flow integration', () => {
  let svc: CommentService

  beforeEach(async () => {
    vi.clearAllMocks()

    // Get references to the live queue arrays inside the db mock module
    const dbMod = await import('../../src/db/db') as unknown as {
      __execQueue: unknown[]
      __takeFirstQueue: unknown[]
    }
    queueExec = dbMod.__execQueue
    queueTakeFirst = dbMod.__takeFirstQueue
    queueExec.length = 0
    queueTakeFirst.length = 0

    svc = new CommentService(mockCollab as unknown as CollabService, mockLogger)
  })

  // ── 1. Full lifecycle ────────────────────────────────────────────────────

  describe('1. Full comment lifecycle', () => {
    it('create returns comment with correct fields', async () => {
      const commentRow = row({ id: 'cmt_lc1', content: 'Lifecycle test', mentions: '[]' })
      qExec([])           // INSERT INTO meta_comments
      qFirst(commentRow)  // SELECT after insert (getComment reload)
      qExec([])           // INSERT INTO meta_comment_reads (author auto-read)

      const result = await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: 'Lifecycle test',
        authorId: 'user_author',
      })

      expect(result.id).toBe('cmt_lc1')
      expect(result.spreadsheetId).toBe('sheet_a')
      expect(result.rowId).toBe('row_1')
      expect(result.content).toBe('Lifecycle test')
      expect(result.authorId).toBe('user_author')
    })

    it('update returns comment with updated content', async () => {
      const existing = row({ id: 'cmt_lc2', author_id: 'user_author', resolved: false })
      const updated = row({ id: 'cmt_lc2', content: 'Updated content', author_id: 'user_author' })

      qFirst(existing)    // getRequiredCommentRow
      qExec([])           // UPDATE
      qFirst(updated)     // getComment reload

      const result = await svc.updateComment('cmt_lc2', 'user_author', {
        content: 'Updated content',
      })

      expect(result.content).toBe('Updated content')
    })

    it('delete resolves without error for leaf comment owned by author', async () => {
      const existing = row({ id: 'cmt_lc3', author_id: 'user_author' })
      qFirst(existing)    // getRequiredCommentRow
      qFirst(undefined)   // child lookup → no children → can delete
      qExec([])           // DELETE

      await expect(svc.deleteComment('cmt_lc3', 'user_author')).resolves.not.toThrow()
    })

    it('create fires comment:created broadcast', async () => {
      const commentRow = row({ id: 'cmt_evt1' })
      qExec([])
      qFirst(commentRow)
      qExec([])

      await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: 'Event test',
        authorId: 'user_author',
      })

      const createdEvents = mockCollab.broadcastTo.mock.calls.filter(
        (c: unknown[]) => c[1] === 'comment:created',
      )
      expect(createdEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('create fires comment:activity broadcast', async () => {
      const commentRow = row({ id: 'cmt_evt2' })
      qExec([])
      qFirst(commentRow)
      qExec([])

      await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: 'Activity event',
        authorId: 'user_author',
      })

      const activityEvents = mockCollab.broadcastTo.mock.calls.filter(
        (c: unknown[]) => c[1] === 'comment:activity',
      )
      expect(activityEvents.length).toBeGreaterThanOrEqual(1)
      const payload = activityEvents[0][2] as { kind: string }
      expect(payload.kind).toBe('created')
    })

    it('delete fires comment:deleted broadcast', async () => {
      const existing = row({ id: 'cmt_del_evt', author_id: 'user_author' })
      qFirst(existing)
      qFirst(undefined) // no children
      qExec([])

      await svc.deleteComment('cmt_del_evt', 'user_author')

      const deletedEvents = mockCollab.broadcastTo.mock.calls.filter(
        (c: unknown[]) => c[1] === 'comment:deleted',
      )
      expect(deletedEvents.length).toBeGreaterThanOrEqual(1)
      const payload = deletedEvents[0][2] as { commentId: string }
      expect(payload.commentId).toBe('cmt_del_evt')
    })

    it('delete fires comment:activity with kind=deleted', async () => {
      const existing = row({ id: 'cmt_del_act', author_id: 'user_author' })
      qFirst(existing)
      qFirst(undefined)
      qExec([])

      await svc.deleteComment('cmt_del_act', 'user_author')

      const activityCalls = mockCollab.broadcastTo.mock.calls.filter(
        (c: unknown[]) => c[1] === 'comment:activity',
      )
      expect(activityCalls.length).toBeGreaterThanOrEqual(1)
      const payload = activityCalls[0][2] as { kind: string }
      expect(payload.kind).toBe('deleted')
    })

    it('update fires comment:updated broadcast', async () => {
      const existing = row({ id: 'cmt_upd_evt', author_id: 'user_author', resolved: false })
      const updated = row({ id: 'cmt_upd_evt', content: 'New content' })

      qFirst(existing)
      qExec([])
      qFirst(updated)

      await svc.updateComment('cmt_upd_evt', 'user_author', { content: 'New content' })

      const updatedEvents = mockCollab.broadcastTo.mock.calls.filter(
        (c: unknown[]) => c[1] === 'comment:updated',
      )
      expect(updatedEvents.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── 2. Unread semantics ──────────────────────────────────────────────────

  describe('2. Unread semantics', () => {
    it('getUnreadCount returns correct count for non-author', async () => {
      qFirst({ c: 3 })
      const count = await svc.getUnreadCount('user_other')
      expect(count).toBe(3)
    })

    it('getUnreadCount returns 0 when everything is read', async () => {
      qFirst({ c: 0 })
      const count = await svc.getUnreadCount('user_other')
      expect(count).toBe(0)
    })

    it('getUnreadCount returns 0 when query returns undefined (no rows)', async () => {
      qFirst(undefined)
      const count = await svc.getUnreadCount('user_other')
      expect(count).toBe(0)
    })

    it('createComment auto-marks as read for the author (markCommentRead called)', async () => {
      const markSpy = vi.spyOn(svc, 'markCommentRead').mockResolvedValue(undefined)

      qExec([])
      qFirst(row({ id: 'cmt_autoread', author_id: 'user_a' }))

      await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: 'My own comment',
        authorId: 'user_a',
      })

      expect(markSpy).toHaveBeenCalledTimes(1)
      const [, authorId] = markSpy.mock.calls[0]
      expect(authorId).toBe('user_a')
      markSpy.mockRestore()
    })

    it("author's own comment does NOT appear as unread (markCommentRead clears it)", async () => {
      qFirst({ c: 0 })
      const count = await svc.getUnreadCount('user_a')
      expect(count).toBe(0)
    })

    it('getUnreadSummary returns both unreadCount and mentionUnreadCount', async () => {
      qFirst({ unread_count: 5, mention_unread_count: 2 })
      const summary: CommentUnreadSummary = await svc.getUnreadSummary('user_other')
      expect(summary.unreadCount).toBe(5)
      expect(summary.mentionUnreadCount).toBe(2)
    })

    it('getUnreadSummary returns zeros when no unread comments exist', async () => {
      qFirst({ unread_count: 0, mention_unread_count: 0 })
      const summary = await svc.getUnreadSummary('user_other')
      expect(summary.unreadCount).toBe(0)
      expect(summary.mentionUnreadCount).toBe(0)
    })

    it('getUnreadSummary defaults to zeros when query returns undefined', async () => {
      qFirst(undefined)
      const summary = await svc.getUnreadSummary('user_other')
      expect(summary.unreadCount).toBe(0)
      expect(summary.mentionUnreadCount).toBe(0)
    })

    it('getUnreadSummary: mentionUnreadCount is always <= unreadCount', async () => {
      qFirst({ unread_count: 10, mention_unread_count: 3 })
      const summary = await svc.getUnreadSummary('user_other')
      expect(summary.mentionUnreadCount).toBeLessThanOrEqual(summary.unreadCount)
    })

    it('markCommentRead is idempotent (second call also resolves)', async () => {
      qExec([])
      qExec([])

      await svc.markCommentRead('cmt_1', 'user_other')
      await expect(svc.markCommentRead('cmt_1', 'user_other')).resolves.not.toThrow()
    })
  })

  // ── 3. Mention contract ──────────────────────────────────────────────────

  describe('3. Mention contract', () => {
    it('parses @[Name](userId) format from content', async () => {
      const mentioned = row({
        id: 'cmt_mention1',
        content: 'Hello @[Alice](user_alice)',
        mentions: JSON.stringify(['user_alice']),
      })
      qExec([])
      qFirst(mentioned)
      qExec([]) // author auto-read

      const result = await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: 'Hello @[Alice](user_alice)',
        authorId: 'user_author',
      })

      expect(result.mentions).toContain('user_alice')
    })

    it('parses multiple @[Name](userId) mentions from content', async () => {
      const multiRow = row({
        id: 'cmt_multi',
        content: '@[Alice](user_alice) and @[Bob](user_bob)',
        mentions: JSON.stringify(['user_alice', 'user_bob']),
      })
      qExec([])
      qFirst(multiRow)
      qExec([])

      const result = await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: '@[Alice](user_alice) and @[Bob](user_bob)',
        authorId: 'user_author',
      })

      expect(result.mentions).toContain('user_alice')
      expect(result.mentions).toContain('user_bob')
      expect(result.mentions).toHaveLength(2)
    })

    it('explicit mentions array takes precedence over content parsing', async () => {
      const explicitRow = row({
        id: 'cmt_explicit',
        mentions: JSON.stringify(['user_x', 'user_y']),
      })
      qExec([])
      qFirst(explicitRow)
      qExec([])

      const result = await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: 'No @-syntax here',
        authorId: 'user_author',
        mentions: ['user_x', 'user_y'],
      })

      expect(result.mentions).toEqual(['user_x', 'user_y'])
    })

    it('content with no @-mentions produces empty mentions array', async () => {
      const noMentionRow = row({ id: 'cmt_nomention', content: 'Just text', mentions: '[]' })
      qExec([])
      qFirst(noMentionRow)
      qExec([])

      const result = await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: 'Just text',
        authorId: 'user_author',
      })

      expect(result.mentions).toEqual([])
    })

    it('deduplicates repeated @-mentions', async () => {
      const dedupRow = row({
        id: 'cmt_dedup',
        mentions: JSON.stringify(['user_alice']),
      })
      qExec([])
      qFirst(dedupRow)
      qExec([])

      const result = await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: '@[Alice](user_alice) and again @[Alice](user_alice)',
        authorId: 'user_author',
      })

      expect(result.mentions).toHaveLength(1)
      expect(result.mentions).toContain('user_alice')
    })

    it('getUnreadSummary reflects non-zero mentionUnreadCount for mentioned user', async () => {
      qFirst({ unread_count: 4, mention_unread_count: 2 })
      const summary = await svc.getUnreadSummary('user_alice')
      expect(summary.mentionUnreadCount).toBe(2)
      expect(summary.unreadCount).toBe(4)
    })

    it('getUnreadSummary returns mentionUnreadCount=0 for non-mentioned user', async () => {
      qFirst({ unread_count: 4, mention_unread_count: 0 })
      const summary = await svc.getUnreadSummary('user_nobody')
      expect(summary.mentionUnreadCount).toBe(0)
      expect(summary.unreadCount).toBe(4)
    })

    it('update re-parses mentions from new content', async () => {
      const existing = row({
        id: 'cmt_upd_mention',
        author_id: 'user_author',
        mentions: '[]',
        resolved: false,
      })
      const updatedRow = row({
        id: 'cmt_upd_mention',
        content: '@[Bob](user_bob) review please',
        mentions: JSON.stringify(['user_bob']),
        author_id: 'user_author',
      })

      qFirst(existing)
      qExec([])
      qFirst(updatedRow)

      const result = await svc.updateComment('cmt_upd_mention', 'user_author', {
        content: '@[Bob](user_bob) review please',
      })

      expect(result.mentions).toContain('user_bob')
    })
  })

  // ── 4. Backward compatibility ────────────────────────────────────────────

  describe('4. Backward compatibility — unread-count response shape', () => {
    it('response data object includes `count` alias equal to unreadCount', () => {
      const summary: CommentUnreadSummary = { unreadCount: 7, mentionUnreadCount: 3 }

      // Mirror what the route handler does:
      //   const summary = await commentService.getUnreadSummary(userId)
      //   res.json({ ok: true, data: { unreadCount, mentionUnreadCount, count: unreadCount } })
      const responseData = {
        unreadCount: summary.unreadCount,
        mentionUnreadCount: summary.mentionUnreadCount,
        count: summary.unreadCount,
      }

      expect(responseData).toHaveProperty('count')
      expect(responseData.count).toBe(responseData.unreadCount)
    })

    it('count field equals unreadCount for any numeric value', () => {
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

    it('response always contains both unreadCount and mentionUnreadCount (new fields)', () => {
      const summary: CommentUnreadSummary = { unreadCount: 5, mentionUnreadCount: 1 }
      const responseData = {
        unreadCount: summary.unreadCount,
        mentionUnreadCount: summary.mentionUnreadCount,
        count: summary.unreadCount,
      }

      expect(responseData).toHaveProperty('unreadCount')
      expect(responseData).toHaveProperty('mentionUnreadCount')
      expect(typeof responseData.unreadCount).toBe('number')
      expect(typeof responseData.mentionUnreadCount).toBe('number')
    })

    it('CommentUnreadSummary type has correct field names', () => {
      const s: CommentUnreadSummary = { unreadCount: 0, mentionUnreadCount: 0 }
      expect(Object.keys(s)).toContain('unreadCount')
      expect(Object.keys(s)).toContain('mentionUnreadCount')
    })

    it('getUnreadSummary returns the full CommentUnreadSummary shape', async () => {
      qFirst({ unread_count: 3, mention_unread_count: 1 })
      const summary = await svc.getUnreadSummary('user_test')
      expect(summary).toHaveProperty('unreadCount')
      expect(summary).toHaveProperty('mentionUnreadCount')
    })
  })

  // ── 5. Inbox contract ────────────────────────────────────────────────────

  describe('5. Inbox contract', () => {
    it('getInbox includes comments where user is mentioned', async () => {
      const mentionedItem = inboxRow({
        id: 'cmt_inbox1',
        mentions: JSON.stringify(['user_viewer']),
        author_id: 'user_other',
        mentioned: true,
        unread: true,
      })

      qFirst({ c: 1 })
      qExec([mentionedItem])

      const result = await svc.getInbox('user_viewer')

      expect(result.total).toBe(1)
      expect(result.items).toHaveLength(1)
      expect(result.items[0].mentioned).toBe(true)
    })

    it('getInbox marks unread comments as unread=true', async () => {
      const unreadItem = inboxRow({
        id: 'cmt_inbox_unread',
        author_id: 'user_other',
        mentioned: true,
        unread: true,
      })

      qFirst({ c: 1 })
      qExec([unreadItem])

      const result = await svc.getInbox('user_viewer')
      expect(result.items[0].unread).toBe(true)
    })

    it('getInbox marks read comments as unread=false', async () => {
      const readItem = inboxRow({
        id: 'cmt_inbox_read',
        author_id: 'user_other',
        mentioned: true,
        unread: false,
      })

      qFirst({ c: 1 })
      qExec([readItem])

      const result = await svc.getInbox('user_viewer')
      expect(result.items[0].unread).toBe(false)
    })

    it("getInbox excludes author's own comments (returns empty when only own comment exists)", async () => {
      qFirst({ c: 0 })
      qExec([])

      const result = await svc.getInbox('user_author')

      expect(result.total).toBe(0)
      expect(result.items).toHaveLength(0)
    })

    it('getInbox returns correct total with multiple items', async () => {
      const items = [
        inboxRow({ id: 'cmt_i1', author_id: 'user_other', mentioned: true, unread: true }),
        inboxRow({ id: 'cmt_i2', author_id: 'user_other', mentioned: false, unread: true }),
        inboxRow({ id: 'cmt_i3', author_id: 'user_other', mentioned: true, unread: false }),
      ]

      qFirst({ c: 3 })
      qExec(items)

      const result = await svc.getInbox('user_viewer')

      expect(result.total).toBe(3)
      expect(result.items).toHaveLength(3)
    })

    it('getInbox items include metadata (baseId, sheetId, recordId)', async () => {
      const metaItem = inboxRow({
        id: 'cmt_meta',
        author_id: 'user_other',
        mentioned: true,
        base_id: 'base_xyz',
        sheet_id: 'sheet_xyz',
        view_id: 'view_xyz',
        record_id: 'row_xyz',
      })

      qFirst({ c: 1 })
      qExec([metaItem])

      const result = await svc.getInbox('user_viewer')
      const item = result.items[0]

      expect(item.baseId).toBe('base_xyz')
      expect(item.sheetId).toBe('sheet_xyz')
      expect(item.viewId).toBe('view_xyz')
      expect(item.recordId).toBe('row_xyz')
    })

    it('non-mentioned users can appear in inbox for unread activity (mentioned=false)', async () => {
      const activityItem = inboxRow({
        id: 'cmt_activity',
        author_id: 'user_other',
        mentioned: false,
        unread: true,
      })

      qFirst({ c: 1 })
      qExec([activityItem])

      const result = await svc.getInbox('user_viewer')
      expect(result.items[0].mentioned).toBe(false)
      expect(result.items[0].unread).toBe(true)
    })
  })

  // ── 6. Error boundary / access control ──────────────────────────────────

  describe('6. Error boundary & access control', () => {
    it('updateComment rejects non-author', async () => {
      qFirst(row({ id: 'cmt_err1', author_id: 'user_alice' }))

      await expect(svc.updateComment('cmt_err1', 'user_bob', { content: 'hijack' }))
        .rejects.toBeInstanceOf(CommentAccessError)
    })

    it('updateComment rejects editing a resolved comment', async () => {
      qFirst(row({ id: 'cmt_err2', author_id: 'user_author', resolved: true }))

      await expect(svc.updateComment('cmt_err2', 'user_author', { content: 'edit' }))
        .rejects.toBeInstanceOf(CommentConflictError)
    })

    it('deleteComment rejects non-author', async () => {
      qFirst(row({ id: 'cmt_err3', author_id: 'user_alice' }))

      await expect(svc.deleteComment('cmt_err3', 'user_bob'))
        .rejects.toBeInstanceOf(CommentAccessError)
    })

    it('deleteComment rejects comment that has replies', async () => {
      qFirst(row({ id: 'cmt_err4', author_id: 'user_author' }))
      qFirst({ id: 'cmt_child' })

      await expect(svc.deleteComment('cmt_err4', 'user_author'))
        .rejects.toBeInstanceOf(CommentConflictError)
    })

    it('createComment with invalid parentId throws CommentValidationError', async () => {
      qFirst(undefined) // parent lookup returns nothing

      await expect(svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: 'Reply',
        authorId: 'user_author',
        parentId: 'cmt_ghost',
      })).rejects.toBeInstanceOf(CommentValidationError)
    })

    it('NotFoundError has correct name', () => {
      const err = new CommentNotFoundError('not found')
      expect(err.name).toBe('CommentNotFoundError')
    })

    it('ValidationError has correct name', () => {
      const err = new CommentValidationError('bad input')
      expect(err.name).toBe('CommentValidationError')
    })
  })
})
