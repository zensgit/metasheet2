import { describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableCommentInboxSummary } from '../src/multitable/composables/useMultitableCommentInboxSummary'
import type { CommentMentionSummary } from '../src/multitable/types'

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn().mockResolvedValue('user_self'),
  }),
}))

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

async function flushAsync(cycles = 4): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
  }
}

async function waitForCondition(check: () => boolean, cycles = 20): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    if (check()) return
    await flushAsync()
  }
}

describe('mention inbox realtime reconciliation', () => {
  it('create event increments unread only when the current user is mentioned', async () => {
    const inbox = useMultitableCommentInboxSummary({ client: makeMockClient() })
    await inbox.loadSummary({ spreadsheetId: 'sheet_1' })

    inbox.onRealtimeCommentCreated({
      spreadsheetId: 'sheet_1',
      comment: {
        spreadsheetId: 'sheet_1',
        rowId: 'r1',
        targetFieldId: 'f2',
        mentions: ['user_self'],
      },
    })
    await flushAsync()

    expect(inbox.unreadMentionCount.value).toBe(3)
    expect(inbox.summary.value!.unresolvedMentionCount).toBe(4)
    expect(inbox.summary.value!.items.find((item) => item.rowId === 'r1')).toEqual({
      rowId: 'r1',
      mentionedCount: 3,
      unreadCount: 2,
      mentionedFieldIds: ['f1', 'f2'],
    })
  })

  it('create event ignores comments that do not mention the current user', async () => {
    const inbox = useMultitableCommentInboxSummary({ client: makeMockClient() })
    await inbox.loadSummary({ spreadsheetId: 'sheet_1' })

    inbox.onRealtimeCommentCreated({
      spreadsheetId: 'sheet_1',
      comment: {
        spreadsheetId: 'sheet_1',
        rowId: 'r1',
        mentions: ['user_other'],
      },
    })
    await flushAsync()

    expect(inbox.unreadMentionCount.value).toBe(2)
    expect(inbox.summary.value!.unresolvedMentionCount).toBe(3)
    expect(inbox.summary.value!.items.find((item) => item.rowId === 'r1')).toEqual({
      rowId: 'r1',
      mentionedCount: 2,
      unreadCount: 1,
      mentionedFieldIds: ['f1'],
    })
  })

  it('resolved event refreshes the summary instead of blindly decrementing local counts', async () => {
    const refreshedSummary: CommentMentionSummary = {
      spreadsheetId: 'sheet_1',
      unresolvedMentionCount: 2,
      unreadMentionCount: 1,
      mentionedRecordCount: 1,
      unreadRecordCount: 1,
      items: [
        { rowId: 'r1', mentionedCount: 2, unreadCount: 1, mentionedFieldIds: ['f1'] },
      ],
    }
    let summaryLoadCount = 0
    const inbox = useMultitableCommentInboxSummary({
      client: new MultitableApiClient({
        fetchFn: vi.fn(async (input: string) => {
          if (!input.includes('mention-summary')) throw new Error(`Unexpected: ${input}`)
          summaryLoadCount += 1
          return new Response(JSON.stringify({
            ok: true,
            data: summaryLoadCount === 1 ? MOCK_SUMMARY : refreshedSummary,
          }), { status: 200 })
        }),
      }),
    })
    await inbox.loadSummary({ spreadsheetId: 'sheet_1' })

    inbox.onRealtimeCommentResolved({
      spreadsheetId: 'sheet_1',
      rowId: 'r2',
      commentId: 'c2',
    })
    await waitForCondition(() => inbox.summary.value?.mentionedRecordCount === refreshedSummary.mentionedRecordCount)

    expect(summaryLoadCount).toBe(2)
    expect(inbox.summary.value).toEqual(refreshedSummary)
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
          spreadsheetId: 'sheet_1',
          rowId: 'r1',
          createdAt: '2026-04-04T09:59:59.000Z',
          mentions: ['user_self'],
        },
      })
      await flushAsync()

      expect(inbox.unreadMentionCount.value).toBe(0)

      inbox.onRealtimeCommentCreated({
        spreadsheetId: 'sheet_1',
        comment: {
          spreadsheetId: 'sheet_1',
          rowId: 'r1',
          createdAt: '2026-04-04T10:00:01.000Z',
          mentions: ['user_self'],
        },
      })
      await flushAsync()

      expect(inbox.unreadMentionCount.value).toBe(1)
      expect(inbox.summary.value!.items.find((item) => item.rowId === 'r1')!.unreadCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
