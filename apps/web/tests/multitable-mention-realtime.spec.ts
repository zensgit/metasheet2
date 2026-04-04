import { describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableCommentInboxSummary } from '../src/multitable/composables/useMultitableCommentInboxSummary'
import type { CommentMentionSummary } from '../src/multitable/types'

const MOCK_SUMMARY: CommentMentionSummary = {
  spreadsheetId: 'sheet_1',
  unresolvedMentionCount: 3,
  unreadMentionCount: 2,
  mentionedRecordCount: 2,
  unreadRecordCount: 2,
  items: [
    { rowId: 'r1', mentionedCount: 2, unreadCount: 1, mentionedFieldIds: ['f1'] },
    { rowId: 'r2', mentionedCount: 1, unreadCount: 1, mentionedFieldIds: [] },
  ],
}

function makeMockClient() {
  return new MultitableApiClient({
    fetchFn: vi.fn(async (input: string) => {
      if (input.includes('mark-read')) return new Response(null, { status: 204 })
      if (input.includes('mention-summary')) {
        return new Response(JSON.stringify({ ok: true, data: MOCK_SUMMARY }), { status: 200 })
      }
      throw new Error(`Unexpected: ${input}`)
    }),
  })
}

describe('mention inbox realtime reconciliation', () => {
  it('create event increments unread for current sheet', async () => {
    const inbox = useMultitableCommentInboxSummary({ client: makeMockClient() })
    await inbox.loadSummary({ spreadsheetId: 'sheet_1' })

    inbox.onRealtimeCommentCreated({
      spreadsheetId: 'sheet_1',
      comment: { containerId: 'sheet_1', targetId: 'r1' },
    })

    expect(inbox.unreadMentionCount.value).toBe(3)
    expect(inbox.summary.value!.unresolvedMentionCount).toBe(4)
    expect(inbox.summary.value!.items.find((item) => item.rowId === 'r1')!.unreadCount).toBe(2)
  })

  it('resolved event decrements and removes empty rows', async () => {
    const inbox = useMultitableCommentInboxSummary({ client: makeMockClient() })
    await inbox.loadSummary({ spreadsheetId: 'sheet_1' })

    inbox.onRealtimeCommentResolved({
      spreadsheetId: 'sheet_1',
      rowId: 'r2',
      commentId: 'c2',
    })

    expect(inbox.summary.value!.items.find((item) => item.rowId === 'r2')).toBeUndefined()
    expect(inbox.summary.value!.mentionedRecordCount).toBe(1)
  })

  it('resolved event decrements counts without removing rows that still have mentions', async () => {
    const inbox = useMultitableCommentInboxSummary({ client: makeMockClient() })
    await inbox.loadSummary({ spreadsheetId: 'sheet_1' })

    inbox.onRealtimeCommentResolved({
      spreadsheetId: 'sheet_1',
      rowId: 'r1',
      commentId: 'c1',
    })

    expect(inbox.summary.value!.items.find((item) => item.rowId === 'r1')).toEqual({
      rowId: 'r1',
      mentionedCount: 1,
      unreadCount: 0,
      mentionedFieldIds: ['f1'],
    })
    expect(inbox.summary.value!.unresolvedMentionCount).toBe(2)
    expect(inbox.summary.value!.unreadMentionCount).toBe(1)
    expect(inbox.summary.value!.unreadRecordCount).toBe(1)
  })

  it('markRead only suppresses stale create events that predate the read marker', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-04-04T10:00:00.000Z'))
      const inbox = useMultitableCommentInboxSummary({ client: makeMockClient() })
      await inbox.loadSummary({ spreadsheetId: 'sheet_1' })
      await inbox.markRead({ spreadsheetId: 'sheet_1' })

      inbox.onRealtimeCommentCreated({
        spreadsheetId: 'sheet_1',
        comment: {
          containerId: 'sheet_1',
          targetId: 'r1',
          createdAt: '2026-04-04T09:59:59.000Z',
        },
      })

      expect(inbox.unreadMentionCount.value).toBe(0)

      inbox.onRealtimeCommentCreated({
        spreadsheetId: 'sheet_1',
        comment: {
          containerId: 'sheet_1',
          targetId: 'r1',
          createdAt: '2026-04-04T10:00:01.000Z',
        },
      })

      expect(inbox.unreadMentionCount.value).toBe(1)
      expect(inbox.summary.value!.items.find((item) => item.rowId === 'r1')!.unreadCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
