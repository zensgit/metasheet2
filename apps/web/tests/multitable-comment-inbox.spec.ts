import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMultitableCommentInbox } from '../src/multitable/composables/useMultitableCommentInbox'
import { MultitableApiClient } from '../src/multitable/api/client'

function createMockClient() {
  return new MultitableApiClient({
    fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })),
  })
}

describe('useMultitableCommentInbox', () => {
  let client: MultitableApiClient

  beforeEach(() => {
    client = createMockClient()
  })

  it('loads inbox items and unread count', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: {
          items: [{
            id: 'c1',
            spreadsheetId: 'sheet_ops',
            rowId: 'rec_1',
            authorId: 'user_2',
            content: 'hello',
            resolved: false,
            mentions: ['user_1'],
            createdAt: '2026-04-04T00:00:00.000Z',
            unread: true,
          }],
          total: 1,
          limit: 50,
          offset: 0,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: { count: 1 },
      }), { status: 200 }))
    ;(client as any).fetch = fetch

    const state = useMultitableCommentInbox(client)
    await state.loadInbox()
    await state.refreshUnreadCount()

    expect(state.items.value).toHaveLength(1)
    expect(state.items.value[0].containerId).toBe('sheet_ops')
    expect(state.unreadCount.value).toBe(1)
  })

  it('marks an inbox item as read and updates unread count locally', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    ;(client as any).fetch = fetch

    const state = useMultitableCommentInbox(client)
    state.items.value = [{
      id: 'c1',
      containerId: 'sheet_ops',
      targetId: 'rec_1',
      fieldId: null,
      parentId: undefined,
      mentions: ['user_1'],
      authorId: 'user_2',
      authorName: 'Jamie',
      content: 'hello',
      resolved: false,
      createdAt: '2026-04-04T00:00:00.000Z',
      updatedAt: undefined,
      unread: true,
    }]
    state.unreadCount.value = 1

    await state.markRead('c1')

    expect(fetch).toHaveBeenCalledWith('/api/comments/c1/read', { method: 'POST' })
    expect(state.items.value[0].unread).toBe(false)
    expect(state.unreadCount.value).toBe(0)
  })
})
