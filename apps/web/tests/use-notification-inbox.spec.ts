/**
 * Notification Center S1b — useNotificationInbox composable.
 * Locks: list/mark logic + the review-fixed invariant that UI-facing actions NEVER throw (a rejected
 * bell click would leak as an unhandled rejection / Vue console error). loadInbox + markRead resolve
 * and set `error` on failure rather than rejecting; refreshUnreadCount is non-fatal.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/composables/useLocale', () => ({ useLocale: () => ({ isZh: { value: false } }) }))

import { useNotificationInbox } from '../src/multitable/composables/useNotificationInbox'
import type { MetaRecordSubscriptionNotification } from '../src/multitable/types'

function notif(id: string, readAt: string | null = null): MetaRecordSubscriptionNotification {
  return { id, sheetId: 's1', recordId: `rec_${id}`, userId: 'u1', eventType: 'record.updated', actorId: null, revisionId: null, commentId: null, createdAt: '2026-06-16T00:00:00Z', readAt }
}
function fakeClient(over: Record<string, unknown> = {}) {
  return {
    listRecordSubscriptionNotifications: vi.fn(async () => [notif('a'), notif('b', '2026-06-16T01:00:00Z')]),
    getRecordSubscriptionUnreadCount: vi.fn(async () => 1),
    markRecordSubscriptionNotificationsRead: vi.fn(async () => 1),
    markAllRecordSubscriptionNotificationsRead: vi.fn(async () => 1),
    ...over,
  } as never
}

describe('useNotificationInbox (S1b)', () => {
  it('loadInbox populates notifications on success', async () => {
    const inbox = useNotificationInbox(fakeClient())
    const items = await inbox.loadInbox()
    expect(items.length).toBe(2)
    expect(inbox.notifications.value.length).toBe(2)
    expect(inbox.error.value).toBeNull()
  })

  it('loadInbox sets error and RESOLVES on failure (no unhandled rejection)', async () => {
    const inbox = useNotificationInbox(fakeClient({ listRecordSubscriptionNotifications: vi.fn(async () => { throw new Error('boom') }) }))
    await expect(inbox.loadInbox()).resolves.toBeDefined()
    expect(inbox.error.value).toBe('boom')
    expect(inbox.loading.value).toBe(false)
  })

  it('markRead sets readAt locally + refreshes the badge on success', async () => {
    const client = fakeClient({ getRecordSubscriptionUnreadCount: vi.fn(async () => 0) })
    const inbox = useNotificationInbox(client)
    await inbox.loadInbox()
    await inbox.markRead(['a'])
    expect(inbox.notifications.value.find((n) => n.id === 'a')?.readAt).toBeTruthy()
    expect(inbox.unreadCount.value).toBe(0)
    expect((client as unknown as { markRecordSubscriptionNotificationsRead: ReturnType<typeof vi.fn> }).markRecordSubscriptionNotificationsRead).toHaveBeenCalledWith(['a'])
  })

  it('markRead sets error and RESOLVES on failure (no unhandled rejection)', async () => {
    const inbox = useNotificationInbox(fakeClient({ markRecordSubscriptionNotificationsRead: vi.fn(async () => { throw new Error('netfail') }) }))
    await inbox.loadInbox()
    await expect(inbox.markRead(['a'])).resolves.toBeUndefined()
    expect(inbox.error.value).toBe('netfail')
  })

  it('markAllRead marks every local row read and zeroes the badge', async () => {
    const inbox = useNotificationInbox(fakeClient())
    await inbox.loadInbox()
    await inbox.markAllRead()
    expect(inbox.notifications.value.every((n) => n.readAt)).toBe(true)
    expect(inbox.unreadCount.value).toBe(0)
  })

  it('refreshUnreadCount keeps the prior count on failure (non-fatal badge)', async () => {
    const get = vi.fn().mockResolvedValueOnce(5).mockRejectedValueOnce(new Error('x'))
    const inbox = useNotificationInbox(fakeClient({ getRecordSubscriptionUnreadCount: get }))
    await inbox.refreshUnreadCount()
    expect(inbox.unreadCount.value).toBe(5)
    await inbox.refreshUnreadCount() // fails → keeps 5, never rejects
    expect(inbox.unreadCount.value).toBe(5)
  })
})
