import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableCommentInboxSummary } from '../src/multitable/composables/useMultitableCommentInboxSummary'
import type { CommentMentionSummary } from '../src/multitable/types'

const MOCK_SUMMARY: CommentMentionSummary = {
  spreadsheetId: 'sheet_1',
  unresolvedMentionCount: 5,
  unreadMentionCount: 3,
  mentionedRecordCount: 3,
  unreadRecordCount: 2,
  items: [
    { rowId: 'r1', mentionedCount: 3, unreadCount: 2, mentionedFieldIds: ['f1', 'f2'] },
    { rowId: 'r2', mentionedCount: 1, unreadCount: 1, mentionedFieldIds: ['f1'] },
    { rowId: 'r3', mentionedCount: 1, unreadCount: 0, mentionedFieldIds: [] },
  ],
}

function makeMockClient(summary: unknown = MOCK_SUMMARY) {
  return new MultitableApiClient({
    fetchFn: vi.fn(async (input: string) => {
      if (input.includes('/api/comments/mention-summary')) {
        return new Response(JSON.stringify({ ok: true, data: summary }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${input}`)
    }),
  })
}

describe('MultitableApiClient.loadMentionSummary', () => {
  it('sends correct query parameters and returns normalized data', async () => {
    const client = makeMockClient()
    const result = await client.loadMentionSummary({ spreadsheetId: 'sheet_1' })
    expect(result.spreadsheetId).toBe('sheet_1')
    expect(result.unresolvedMentionCount).toBe(5)
    expect(result.unreadMentionCount).toBe(3)
    expect(result.mentionedRecordCount).toBe(3)
    expect(result.items).toHaveLength(3)
    expect(result.items[0].mentionedFieldIds).toEqual(['f1', 'f2'])
  })

  it('normalizes malformed summary payloads', async () => {
    const client = makeMockClient({
      spreadsheetId: 'sheet_1',
      unreadMentionCount: 1,
      items: [
        null,
        { rowId: 'r1', mentionedCount: 2, unreadCount: 1, mentionedFieldIds: ['f1', 7, null] },
        { mentionedCount: 3, unreadCount: 2, mentionedFieldIds: ['f2'] },
      ],
    })

    const result = await client.loadMentionSummary({ spreadsheetId: 'sheet_1' })

    expect(result).toEqual({
      spreadsheetId: 'sheet_1',
      unresolvedMentionCount: 0,
      unreadMentionCount: 1,
      mentionedRecordCount: 0,
      unreadRecordCount: 0,
      items: [{ rowId: 'r1', mentionedCount: 2, unreadCount: 1, mentionedFieldIds: ['f1'] }],
    })
  })
})

describe('useMultitableCommentInboxSummary', () => {
  let client: MultitableApiClient

  beforeEach(() => {
    client = makeMockClient()
  })

  it('loads summary and exposes unread counts', async () => {
    const inbox = useMultitableCommentInboxSummary({ client })
    await inbox.loadSummary({ spreadsheetId: 'sheet_1' })

    expect(inbox.summary.value).not.toBeNull()
    expect(inbox.unreadMentionCount.value).toBe(3)
    expect(inbox.unreadRecordCount.value).toBe(2)
    expect(inbox.error.value).toBeNull()
  })

  it('clears summary', async () => {
    const inbox = useMultitableCommentInboxSummary({ client })
    await inbox.loadSummary({ spreadsheetId: 'sheet_1' })
    inbox.clearSummary()

    expect(inbox.summary.value).toBeNull()
    expect(inbox.error.value).toBeNull()
  })

  it('sets error on failure', async () => {
    const failClient = new MultitableApiClient({
      fetchFn: vi.fn(async () => new Response(JSON.stringify({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'DB error' },
      }), { status: 500 })),
    })
    const inbox = useMultitableCommentInboxSummary({ client: failClient })
    await inbox.loadSummary({ spreadsheetId: 'sheet_1' })

    expect(inbox.summary.value).toBeNull()
    expect(inbox.error.value).toContain('DB error')
  })

  it('skips load for empty spreadsheetId', async () => {
    const inbox = useMultitableCommentInboxSummary({ client })
    await inbox.loadSummary({ spreadsheetId: '' })
    expect(inbox.summary.value).toBeNull()
  })

  it('markRead clears unread counters locally', async () => {
    const markReadClient = new MultitableApiClient({
      fetchFn: vi.fn(async (input: string) => {
        if (input.includes('mark-read')) return new Response(null, { status: 204 })
        return new Response(JSON.stringify({ ok: true, data: MOCK_SUMMARY }), { status: 200 })
      }),
    })
    const inbox = useMultitableCommentInboxSummary({ client: markReadClient })
    await inbox.loadSummary({ spreadsheetId: 'sheet_1' })

    await inbox.markRead({ spreadsheetId: 'sheet_1' })

    expect(inbox.unreadMentionCount.value).toBe(0)
    expect(inbox.unreadRecordCount.value).toBe(0)
    expect(inbox.summary.value?.items.every((item) => item.unreadCount === 0)).toBe(true)
  })
})
