import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ILogger } from '../../src/di/identifiers'

// B6 comment-reaction tests. Mirrors the mock-DB harness used by
// comment-service.test.ts (this repo's comment suites are mock-DB; real-PG
// behaviour of the migration is covered by CI migration-replay). The NFC
// allowlist guard is a pure exported function, tested directly below.

// ── DB mock (identical shape to comment-service.test.ts) ─────────────────────
vi.mock('../../src/db/db', () => {
  const _executeResults: unknown[] = []
  const _executeTakeFirstResults: unknown[] = []

  function makeChain(): Record<string, unknown> {
    const self: Record<string, unknown> = {}
    const chainFn = (..._args: unknown[]) => self
    const methods = [
      'selectFrom', 'selectAll', 'select', 'where', 'orderBy',
      'limit', 'offset', 'groupBy', 'insertInto', 'values',
      'onConflict', 'columns', 'doUpdateSet', 'doNothing',
      'updateTable', 'set', 'deleteFrom', 'returningAll', 'leftJoin',
    ]
    for (const m of methods) self[m] = vi.fn(chainFn)
    self.execute = vi.fn(async () => _executeResults.shift() ?? [])
    self.executeTakeFirst = vi.fn(async () => _executeTakeFirstResults.shift())
    return self
  }

  const rootChain: Record<string, unknown> = {}
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

vi.mock('../../src/db/type-helpers', () => ({ nowTimestamp: () => 'NOW()' }))

const mockCollabService = {
  broadcastTo: vi.fn(), sendTo: vi.fn(), broadcast: vi.fn(),
  initialize: vi.fn(), join: vi.fn(), leave: vi.fn(), onConnection: vi.fn(),
}
const mockLogger: ILogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

const mockNotifyRecordSubscribersWithKysely = vi.fn()
vi.mock('../../src/multitable/record-subscription-service', () => ({
  notifyRecordSubscribersWithKysely: (...args: unknown[]) => mockNotifyRecordSubscribersWithKysely(...args),
}))

import {
  CommentService,
  CommentValidationError,
  CommentNotFoundError,
  COMMENT_REACTION_EMOJIS,
  normalizeCommentReactionEmoji,
} from '../../src/services/CommentService'
import type { CollabService } from '../../src/services/CollabService'

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

function makeCommentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmt_test-1', spreadsheet_id: 'sheet-1', row_id: 'row-1', field_id: null,
    content: 'Hello world', author_id: 'user-author', parent_id: null, resolved: false,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    mentions: '[]', ...overrides,
  }
}
const pushTakeFirst = (...r: unknown[]) => queueTakeFirst.push(...r)
const pushExec = (...r: unknown[]) => queueExec.push(...r)

// ─────────────────────────────────────────────────────────────────────────────
// normalizeCommentReactionEmoji — the NFC + allowlist guard (pure, no DB)
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeCommentReactionEmoji', () => {
  it('accepts every allowlisted emoji and returns it NFC-normalized', () => {
    for (const e of COMMENT_REACTION_EMOJIS) {
      expect(normalizeCommentReactionEmoji(e)).toBe(e.normalize('NFC'))
    }
  })

  it('trims surrounding whitespace before matching', () => {
    expect(normalizeCommentReactionEmoji('  👍  ')).toBe('👍')
  })

  it('normalizes a multi-codepoint emoji consistently (❤️ = ❤ + U+FE0F)', () => {
    // The same heart with an explicit variation selector must normalize to the
    // stored allowlist form so add + remove always agree on the bytes.
    const heartVs16 = '❤️'
    expect(normalizeCommentReactionEmoji(heartVs16)).toBe('❤️'.normalize('NFC'))
    // Idempotent: normalizing the result again yields the same value.
    const once = normalizeCommentReactionEmoji(heartVs16)
    expect(normalizeCommentReactionEmoji(once)).toBe(once)
  })

  it('rejects an emoji outside the allowlist', () => {
    expect(() => normalizeCommentReactionEmoji('💩')).toThrow(CommentValidationError)
    // bare heart without the variation selector is NOT the allowlisted form
    expect(() => normalizeCommentReactionEmoji('❤')).toThrow(CommentValidationError)
  })

  it('rejects empty / non-string input', () => {
    expect(() => normalizeCommentReactionEmoji('')).toThrow(CommentValidationError)
    expect(() => normalizeCommentReactionEmoji('   ')).toThrow(CommentValidationError)
    expect(() => normalizeCommentReactionEmoji(undefined as unknown as string)).toThrow(CommentValidationError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Service methods (mock DB)
// ─────────────────────────────────────────────────────────────────────────────
describe('CommentService reactions', () => {
  let service: CommentService

  beforeEach(() => {
    vi.clearAllMocks()
    queueExec.length = 0
    queueTakeFirst.length = 0
    mockNotifyRecordSubscribersWithKysely.mockResolvedValue({ inserted: 0, userIds: [] })
    service = new CommentService(mockCollabService as unknown as CollabService, mockLogger)
  })

  describe('addReaction', () => {
    it('rejects a non-allowlisted emoji before any DB access', async () => {
      await expect(service.addReaction('cmt_test-1', 'user-1', '💩')).rejects.toBeInstanceOf(CommentValidationError)
      // validation happens before the comment lookup → no takeFirst consumed
      expect(queueTakeFirst.length).toBe(0)
    })

    it('rejects an empty author id', async () => {
      await expect(service.addReaction('cmt_test-1', '   ', '👍')).rejects.toThrow()
    })

    it('404s a missing comment', async () => {
      pushTakeFirst(undefined) // getRequiredCommentRow → not found
      await expect(service.addReaction('cmt_missing', 'user-1', '👍')).rejects.toBeInstanceOf(CommentNotFoundError)
    })

    it('inserts when the comment exists and the emoji is valid', async () => {
      pushTakeFirst(makeCommentRow()) // getRequiredCommentRow
      pushExec([]) // insert
      await expect(service.addReaction('cmt_test-1', 'user-1', '👍')).resolves.toBeUndefined()
    })
  })

  describe('removeReaction', () => {
    it('rejects a non-allowlisted emoji', async () => {
      await expect(service.removeReaction('cmt_test-1', 'user-1', 'nope')).rejects.toBeInstanceOf(CommentValidationError)
    })

    it('deletes (idempotent — no comment lookup, no-op if absent)', async () => {
      pushExec([]) // delete
      await expect(service.removeReaction('cmt_test-1', 'user-1', '👍')).resolves.toBeUndefined()
    })
  })

  describe('listReactionsForComments', () => {
    it('returns an empty map for empty input WITHOUT querying (IN () guard)', async () => {
      const map = await service.listReactionsForComments([], 'user-1')
      expect(map.size).toBe(0)
      // guard short-circuits before any execute()
      expect(queueExec.length).toBe(0)
    })

    it('aggregates rows into per-comment summaries with numeric count + boolean reactedByMe', async () => {
      pushExec([
        { comment_id: 'c1', emoji: '👍', count: 3, reacted_by_me: 1 },
        { comment_id: 'c1', emoji: '❤️', count: 1, reacted_by_me: 0 },
        { comment_id: 'c2', emoji: '👍', count: 2, reacted_by_me: 0 },
      ])
      const map = await service.listReactionsForComments(['c1', 'c2'], 'user-1')
      expect(map.get('c1')).toEqual([
        { emoji: '👍', count: 3, reactedByMe: true },
        { emoji: '❤️', count: 1, reactedByMe: false },
      ])
      expect(map.get('c2')).toEqual([{ emoji: '👍', count: 2, reactedByMe: false }])
    })
  })

  describe('getComments hydrates reactions', () => {
    it('attaches the aggregated reactions to each returned comment', async () => {
      pushTakeFirst({ c: 1 }) // count
      pushExec([makeCommentRow({ id: 'cmt_test-1' })]) // comment rows
      pushExec([{ comment_id: 'cmt_test-1', emoji: '🎉', count: 2, reacted_by_me: 1 }]) // reactions
      const { items } = await service.getComments('sheet-1', { viewerId: 'user-1' })
      expect(items[0].reactions).toEqual([{ emoji: '🎉', count: 2, reactedByMe: true }])
    })

    it('sets reactions to [] for a comment with none', async () => {
      pushTakeFirst({ c: 1 })
      pushExec([makeCommentRow({ id: 'cmt_test-1' })])
      pushExec([]) // no reactions
      const { items } = await service.getComments('sheet-1')
      expect(items[0].reactions).toEqual([])
    })
  })

  describe('deleteComment cascades reactions', () => {
    it('completes (reaction rows removed in the same transaction)', async () => {
      pushTakeFirst(makeCommentRow({ author_id: 'user-author' })) // getRequiredCommentRow
      pushTakeFirst(undefined) // no child comment
      await expect(service.deleteComment('cmt_test-1', 'user-author')).resolves.toBeUndefined()
    })
  })
})
