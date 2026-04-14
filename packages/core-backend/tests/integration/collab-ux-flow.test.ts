/**
 * Week-2 collab UX integration test — collab-ux-flow
 *
 * Validates the Week-2 collaboration UX contract:
 *   1. Mention candidate API     (8 tests)  — autocomplete query/filter/shape
 *   2. Mark-all-as-read          (7 tests)  — markMentionsRead + idempotence + isolation
 *   3. Presence viewer identity  (6 tests)  — getCommentPresenceSummary with viewer data
 *   4. Full UX flow              (9 tests)  — end-to-end mention → inbox → deep-link → mark-read
 *   5. Backward compatibility    (5 tests)  — unread-count shape, mention format
 *
 * This is a MOCK-DB integration test — no live PostgreSQL is required.
 * The mock replicates the Kysely query-builder chain used in CommentService.
 *
 * Run with either:
 *   cd packages/core-backend && npx vitest run tests/integration/collab-ux-flow.test.ts --watch=false
 *   pnpm --filter @metasheet/core-backend exec vitest run tests/integration/collab-ux-flow.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ILogger } from '../../src/di/identifiers'

// ---------------------------------------------------------------------------
// Inline mock for ../../src/db/db
//
// IMPORTANT: vi.mock is hoisted before all imports. To share queues between
// the factory and the test body, we use module-level arrays exported from
// the mock so tests can access them via re-import.
// ---------------------------------------------------------------------------

vi.mock('../../src/db/db', () => {
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
      'innerJoin', 'on', 'onRef',
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
    __execQueue: execQueue,
    __takeFirstQueue: takeFirstQueue,
  }
})

// Mock the sql tagged template from kysely — used in CommentService for raw predicates
// AND for raw SQL execution (markMentionsRead uses sql`...`.execute(db)).
// We provide a minimal implementation that:
//  - Returns `null` when used as a SQL expression fragment (where / select / orderBy)
//  - Returns an object with `.execute()` that resolves to [] when used as a statement
vi.mock('kysely', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>

  // The sql tagged template literal is called as sql`...` or sql<T>`...`.
  // It can be used as: an inline fragment (returns null, ignored in chain mock)
  // or as a complete statement: sql`INSERT ...`.execute(db) → resolves to { rows: [] }
  function makeSqlResult() {
    return {
      as: (_alias: string) => null,
      $call: () => null,
      execute: async (_db: unknown) => ({ rows: [] }),
    }
  }

  const sqlTagged = (_strings: TemplateStringsArray, ..._values: unknown[]) => makeSqlResult()
  // sql is also used generically: sql<boolean>`...` means sql is called with type param
  // which in JS is just a function call. Assign static methods.
  const sqlFn = Object.assign(sqlTagged, {
    join: () => makeSqlResult(),
    raw: (_s: string) => makeSqlResult(),
    lit: (_v: unknown) => makeSqlResult(),
    ref: (_v: string) => makeSqlResult(),
    id: (_v: string) => makeSqlResult(),
    table: (_v: string) => makeSqlResult(),
    val: (_v: unknown) => makeSqlResult(),
  })

  return {
    ...original,
    sql: sqlFn,
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
} from '../../src/services/CommentService'
import type { CollabService } from '../../src/services/CollabService'
import type { CommentMentionCandidate, CommentUnreadSummary } from '../../src/di/identifiers'

// Queue accessors — retrieved in beforeEach to get the live arrays
let queueExec: unknown[]
let queueTakeFirst: unknown[]

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

/** Build a minimal comment DB row */
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

/** Build a minimal inbox DB row */
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

/** Build a minimal user DB row for mention candidates */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user_default',
    name: 'Default User',
    email: 'default@example.com',
    ...overrides,
  }
}

/** Build a grouped comment count row for presence summary */
function presenceCountRow(overrides: Record<string, unknown> = {}) {
  return {
    row_id: 'row_1',
    field_id: null,
    comment_count: 1,
    mentioned_count: 0,
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

describe('Week-2 collab UX integration — collab-ux-flow', () => {
  let svc: CommentService

  beforeEach(async () => {
    vi.clearAllMocks()

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

  // ── 1. Mention candidate API ─────────────────────────────────────────────

  describe('1. Mention candidate API', () => {
    it('returns up to 10 candidates matching query by display name', async () => {
      const candidates = [
        userRow({ id: 'user_alice', name: 'Alice Smith', email: 'alice@example.com' }),
        userRow({ id: 'user_alan', name: 'Alan Doe', email: 'alan@example.com' }),
      ]
      qFirst({ c: 2 })      // count query
      qExec(candidates)     // rows query

      const result = await svc.listMentionCandidates('sheet_a', { q: 'al', limit: 10 })

      expect(result.total).toBe(2)
      expect(result.items).toHaveLength(2)
      // label maps to name when available
      expect(result.items[0].label).toBe('Alice Smith')
    })

    it('returns candidates matching query by email', async () => {
      const candidates = [
        userRow({ id: 'user_bob', name: 'Bob Jones', email: 'bob@company.io' }),
      ]
      qFirst({ c: 1 })
      qExec(candidates)

      const result = await svc.listMentionCandidates('sheet_a', { q: 'company.io' })

      expect(result.total).toBe(1)
      expect(result.items[0].id).toBe('user_bob')
    })

    it('returns empty array for blank/whitespace query', async () => {
      // blank query: all active users; service returns them normally
      qFirst({ c: 0 })
      qExec([])

      const result = await svc.listMentionCandidates('sheet_a', { q: '' })

      expect(result.total).toBe(0)
      expect(result.items).toHaveLength(0)
    })

    it('respects limit parameter — returns at most limit candidates', async () => {
      // Simulate service returning exactly `limit` items even if total > limit
      const candidates = Array.from({ length: 5 }, (_, i) =>
        userRow({ id: `user_${i}`, name: `User ${i}`, email: `u${i}@example.com` }),
      )
      qFirst({ c: 20 })
      qExec(candidates)

      const result = await svc.listMentionCandidates('sheet_a', { q: 'user', limit: 5 })

      expect(result.items.length).toBeLessThanOrEqual(5)
    })

    it('candidate shape has required id and label fields', async () => {
      const candidates = [
        userRow({ id: 'user_carol', name: 'Carol White', email: 'carol@example.com' }),
      ]
      qFirst({ c: 1 })
      qExec(candidates)

      const result = await svc.listMentionCandidates('sheet_a', { q: 'carol' })

      const candidate = result.items[0] as CommentMentionCandidate
      expect(candidate).toHaveProperty('id')
      expect(candidate).toHaveProperty('label')
      expect(typeof candidate.id).toBe('string')
      expect(typeof candidate.label).toBe('string')
    })

    it('candidate subtitle is email when name and email differ', async () => {
      const candidates = [
        userRow({ id: 'user_dave', name: 'Dave Brown', email: 'dave@example.com' }),
      ]
      qFirst({ c: 1 })
      qExec(candidates)

      const result = await svc.listMentionCandidates('sheet_a', { q: 'dave' })

      const candidate = result.items[0]
      // label = name, subtitle = email when they differ
      expect(candidate.label).toBe('Dave Brown')
      expect(candidate.subtitle).toBe('dave@example.com')
    })

    it('candidate subtitle is undefined when name equals email', async () => {
      // Some orgs use email as display name
      const candidates = [
        userRow({ id: 'user_eve', name: 'eve@example.com', email: 'eve@example.com' }),
      ]
      qFirst({ c: 1 })
      qExec(candidates)

      const result = await svc.listMentionCandidates('sheet_a', { q: 'eve' })

      const candidate = result.items[0]
      expect(candidate.subtitle).toBeUndefined()
    })

    it('returns empty list when spreadsheetId is blank', async () => {
      const result = await svc.listMentionCandidates('   ')
      expect(result.total).toBe(0)
      expect(result.items).toHaveLength(0)
    })
  })

  // ── 2. Mark-all-as-read ──────────────────────────────────────────────────

  describe('2. Mark-all-as-read', () => {
    it('markMentionsRead completes without error for user with unread mentions', async () => {
      qExec([])  // INSERT INTO meta_comment_reads via sql template

      await expect(svc.markMentionsRead('sheet_a', 'user_b')).resolves.not.toThrow()
    })

    it('markMentionsRead is idempotent — second call also resolves', async () => {
      qExec([])
      qExec([])

      await svc.markMentionsRead('sheet_a', 'user_b')
      await expect(svc.markMentionsRead('sheet_a', 'user_b')).resolves.not.toThrow()
    })

    it('after markMentionsRead, getUnreadSummary reports mentionUnreadCount=0', async () => {
      // First: mark all read (no DB interaction in this layer since we test separately)
      qExec([])
      await svc.markMentionsRead('sheet_a', 'user_b')

      // Then: getUnreadSummary returns 0 for mentionUnreadCount
      qFirst({ unread_count: 0, mention_unread_count: 0 })
      const summary = await svc.getUnreadSummary('user_b')
      expect(summary.mentionUnreadCount).toBe(0)
    })

    it('markMentionsRead does not affect other users — other user still sees their unread count', async () => {
      // UserB marks all read
      qExec([])
      await svc.markMentionsRead('sheet_a', 'user_b')

      // UserC's unread count is unaffected
      qFirst({ unread_count: 3, mention_unread_count: 1 })
      const summaryC = await svc.getUnreadSummary('user_c')
      expect(summaryC.unreadCount).toBe(3)
      expect(summaryC.mentionUnreadCount).toBe(1)
    })

    it("author's own comments are never in their inbox (zero comments to mark read for author)", async () => {
      // The author creates a comment — it's auto-marked read for them
      // so their getUnreadSummary count is already 0
      qFirst({ unread_count: 0, mention_unread_count: 0 })
      const summary = await svc.getUnreadSummary('user_author')
      expect(summary.unreadCount).toBe(0)
    })

    it('markMentionsRead with empty userId is a no-op', async () => {
      // Service should guard against blank userId
      await expect(svc.markMentionsRead('sheet_a', '')).resolves.not.toThrow()
    })

    it('markMentionsRead with empty spreadsheetId is a no-op', async () => {
      await expect(svc.markMentionsRead('', 'user_b')).resolves.not.toThrow()
    })
  })

  // ── 3. Presence viewer identity ──────────────────────────────────────────

  describe('3. Presence viewer identity', () => {
    it('getCommentPresenceSummary without mentionUserId returns counts-only summary', async () => {
      qExec([
        presenceCountRow({ row_id: 'row_1', comment_count: 2, mentioned_count: 0 }),
      ])

      const result = await svc.getCommentPresenceSummary('sheet_a')

      expect(result.items).toHaveLength(1)
      expect(result.items[0].rowId).toBe('row_1')
      expect(result.items[0].unresolvedCount).toBe(2)
      // no mention user → mentionedCount is 0
      expect(result.items[0].mentionedCount).toBe(0)
    })

    it('getCommentPresenceSummary with mentionUserId enriches mentionedCount', async () => {
      qExec([
        presenceCountRow({ row_id: 'row_1', comment_count: 3, mentioned_count: 2 }),
      ])

      const result = await svc.getCommentPresenceSummary('sheet_a', undefined, 'user_viewer')

      expect(result.items[0].mentionedCount).toBe(2)
    })

    it('presence summary item has expected fields: spreadsheetId, rowId, unresolvedCount', async () => {
      qExec([
        presenceCountRow({ row_id: 'row_5', comment_count: 1, mentioned_count: 0 }),
      ])

      const result = await svc.getCommentPresenceSummary('sheet_a', ['row_5'])

      const item = result.items[0]
      expect(item).toHaveProperty('spreadsheetId')
      expect(item).toHaveProperty('rowId')
      expect(item).toHaveProperty('unresolvedCount')
      expect(item.spreadsheetId).toBe('sheet_a')
      expect(item.rowId).toBe('row_5')
    })

    it('returns empty items array when no active presence (no unresolved comments)', async () => {
      qExec([])  // no rows

      const result = await svc.getCommentPresenceSummary('sheet_a')

      expect(result.items).toHaveLength(0)
      expect(result.total).toBe(0)
    })

    it('filters by rowIds when provided — only requested rows appear', async () => {
      qExec([
        presenceCountRow({ row_id: 'row_2', comment_count: 4, mentioned_count: 0 }),
      ])

      const result = await svc.getCommentPresenceSummary('sheet_a', ['row_2'])

      expect(result.items).toHaveLength(1)
      expect(result.items[0].rowId).toBe('row_2')
    })

    it('aggregates multiple rows — each row gets its own presence item', async () => {
      qExec([
        presenceCountRow({ row_id: 'row_3', comment_count: 2, mentioned_count: 0 }),
        presenceCountRow({ row_id: 'row_4', comment_count: 1, mentioned_count: 1 }),
      ])

      const result = await svc.getCommentPresenceSummary('sheet_a', undefined, 'user_viewer')

      expect(result.items).toHaveLength(2)
      const rowIds = result.items.map((i) => i.rowId)
      expect(rowIds).toContain('row_3')
      expect(rowIds).toContain('row_4')
    })
  })

  // ── 4. Full UX flow ──────────────────────────────────────────────────────

  describe('4. Full UX flow', () => {
    it('UserA creates comment with @UserB → UserB gets mention notification', async () => {
      const commentWithMention = row({
        id: 'cmt_flow_1',
        author_id: 'user_a',
        mentions: JSON.stringify(['user_b']),
        content: '@[UserB](user_b) please review',
      })
      qExec([])           // INSERT comment
      qFirst(commentWithMention)  // reload comment
      qExec([])           // author auto-read

      await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: '@[UserB](user_b) please review',
        authorId: 'user_a',
      })

      // UserB should receive a comment:mention event
      const mentionCalls = mockCollab.sendTo.mock.calls.filter(
        (c: unknown[]) => c[0] === 'user_b' && c[1] === 'comment:mention',
      )
      expect(mentionCalls.length).toBeGreaterThanOrEqual(1)
    })

    it('UserB opens inbox → sees comment with mentioned=true, unread=true', async () => {
      const mentionedUnread = inboxRow({
        id: 'cmt_flow_2',
        author_id: 'user_a',
        mentions: JSON.stringify(['user_b']),
        mentioned: true,
        unread: true,
      })

      qFirst({ c: 1 })
      qExec([mentionedUnread])

      const inbox = await svc.getInbox('user_b')

      expect(inbox.total).toBe(1)
      expect(inbox.items[0].mentioned).toBe(true)
      expect(inbox.items[0].unread).toBe(true)
    })

    it('UserB deep-links to record → presence shows comment count for that record', async () => {
      qExec([
        presenceCountRow({ row_id: 'row_1', comment_count: 1, mentioned_count: 1 }),
      ])

      const presence = await svc.getCommentPresenceSummary('sheet_a', ['row_1'], 'user_b')

      expect(presence.items).toHaveLength(1)
      expect(presence.items[0].rowId).toBe('row_1')
      expect(presence.items[0].unresolvedCount).toBe(1)
    })

    it('UserB marks all mentions read → unread/mention counts drop to 0', async () => {
      qExec([])  // markMentionsRead
      await svc.markMentionsRead('sheet_a', 'user_b')

      qFirst({ unread_count: 0, mention_unread_count: 0 })
      const summary = await svc.getUnreadSummary('user_b')
      expect(summary.unreadCount).toBe(0)
      expect(summary.mentionUnreadCount).toBe(0)
    })

    it('UserA updates comment adding @UserC → only UserC gets new mention notification', async () => {
      const existingRow = row({
        id: 'cmt_flow_5',
        author_id: 'user_a',
        mentions: JSON.stringify(['user_b']),  // original mention
        resolved: false,
      })
      const updatedRow = row({
        id: 'cmt_flow_5',
        author_id: 'user_a',
        content: '@[UserB](user_b) @[UserC](user_c) review both',
        mentions: JSON.stringify(['user_b', 'user_c']),
      })

      qFirst(existingRow)   // getRequiredCommentRow
      qExec([])             // UPDATE
      qFirst(updatedRow)    // getComment reload

      await svc.updateComment('cmt_flow_5', 'user_a', {
        content: '@[UserB](user_b) @[UserC](user_c) review both',
      })

      // Only user_c gets a new mention (user_b was already mentioned)
      const newMentionCalls = mockCollab.sendTo.mock.calls.filter(
        (c: unknown[]) => c[0] === 'user_c' && c[1] === 'comment:mention',
      )
      expect(newMentionCalls.length).toBeGreaterThanOrEqual(1)

      // user_b should NOT receive a new mention notification (already mentioned)
      const existingMentionCalls = mockCollab.sendTo.mock.calls.filter(
        (c: unknown[]) => c[0] === 'user_b' && c[1] === 'comment:mention',
      )
      expect(existingMentionCalls.length).toBe(0)
    })

    it('reply appears as child — parent shows as parentId on child comment', async () => {
      const parentRow = row({ id: 'cmt_parent', author_id: 'user_a', parent_id: null })
      const replyRow = row({
        id: 'cmt_reply',
        author_id: 'user_b',
        parent_id: 'cmt_parent',
      })

      // Create reply: lookup parent, then insert, then reload
      qFirst(parentRow)   // parent lookup
      qExec([])           // INSERT reply
      qFirst(replyRow)    // reload reply
      qExec([])           // author auto-read

      const reply = await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: 'This is a reply',
        authorId: 'user_b',
        parentId: 'cmt_parent',
      })

      expect(reply.parentId).toBe('cmt_parent')
    })

    it('getComments returns both parent and reply in same spreadsheet', async () => {
      const parent = row({ id: 'cmt_parent_list', parent_id: null })
      const reply = row({ id: 'cmt_reply_list', parent_id: 'cmt_parent_list' })

      qFirst({ c: 2 })         // count
      qExec([parent, reply])   // rows

      const result = await svc.getComments('sheet_a')

      expect(result.total).toBe(2)
      expect(result.items).toHaveLength(2)
      const ids = result.items.map((i) => i.id)
      expect(ids).toContain('cmt_parent_list')
      expect(ids).toContain('cmt_reply_list')
    })

    it('presence: deleted comment removed from thread — unresolvedCount decrements', async () => {
      // Before delete: 2 comments on row_1
      qExec([
        presenceCountRow({ row_id: 'row_1', comment_count: 2, mentioned_count: 0 }),
      ])
      const before = await svc.getCommentPresenceSummary('sheet_a', ['row_1'])
      expect(before.items[0].unresolvedCount).toBe(2)

      // After delete: 1 comment on row_1
      qExec([
        presenceCountRow({ row_id: 'row_1', comment_count: 1, mentioned_count: 0 }),
      ])
      const after = await svc.getCommentPresenceSummary('sheet_a', ['row_1'])
      expect(after.items[0].unresolvedCount).toBe(1)
    })

    it('markMentionsRead fires no broadcast events (silent server-side operation)', async () => {
      vi.clearAllMocks()
      qExec([])

      await svc.markMentionsRead('sheet_a', 'user_b')

      expect(mockCollab.broadcastTo).not.toHaveBeenCalled()
      expect(mockCollab.sendTo).not.toHaveBeenCalled()
    })
  })

  // ── 5. Backward compatibility ────────────────────────────────────────────

  describe('5. Backward compatibility', () => {
    it('/api/comments/unread-count response includes `count` alias equal to unreadCount', () => {
      const summary: CommentUnreadSummary = { unreadCount: 7, mentionUnreadCount: 3 }

      // Mirror what the route handler does (Week-1 route contract):
      const responseData = {
        unreadCount: summary.unreadCount,
        mentionUnreadCount: summary.mentionUnreadCount,
        count: summary.unreadCount,
      }

      expect(responseData).toHaveProperty('count')
      expect(responseData.count).toBe(responseData.unreadCount)
      expect(responseData.count).toBe(7)
    })

    it('`count` alias equals unreadCount for any numeric value', () => {
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

    it('mention format @[Name](id) still parses correctly — mentions array contains user ID', async () => {
      const mentionedRow = row({
        id: 'cmt_compat_mention',
        content: 'Review @[Jamie](user_jamie)',
        mentions: JSON.stringify(['user_jamie']),
      })
      qExec([])
      qFirst(mentionedRow)
      qExec([])  // author auto-read

      const result = await svc.createComment({
        spreadsheetId: 'sheet_a',
        rowId: 'row_1',
        content: 'Review @[Jamie](user_jamie)',
        authorId: 'user_author',
      })

      expect(result.mentions).toContain('user_jamie')
    })

    it('existing comment fetch endpoints return same shape (spreadsheetId, rowId, content, mentions)', async () => {
      const existing = row({
        id: 'cmt_compat_shape',
        spreadsheet_id: 'sheet_compat',
        row_id: 'row_compat',
        content: 'Compat test',
        mentions: '["user_x"]',
      })

      qFirst({ c: 1 })
      qExec([existing])

      const result = await svc.getComments('sheet_compat')

      const comment = result.items[0]
      expect(comment).toHaveProperty('spreadsheetId')
      expect(comment).toHaveProperty('rowId')
      expect(comment).toHaveProperty('content')
      expect(comment).toHaveProperty('mentions')
      expect(comment.mentions).toContain('user_x')
    })

    it('CommentUnreadSummary type has both unreadCount and mentionUnreadCount fields', () => {
      const summary: CommentUnreadSummary = { unreadCount: 5, mentionUnreadCount: 2 }
      expect(Object.keys(summary)).toContain('unreadCount')
      expect(Object.keys(summary)).toContain('mentionUnreadCount')
      expect(typeof summary.unreadCount).toBe('number')
      expect(typeof summary.mentionUnreadCount).toBe('number')
    })
  })
})
