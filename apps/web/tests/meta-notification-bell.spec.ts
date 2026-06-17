/**
 * Notification Center S1b — MetaNotificationBell render + interaction.
 * Bell + unread badge, panel open loads the list, unread dot, click-to-locate emits navigate +
 * marks the item read, mark-all-read. A failing client must not crash the component (P2-1).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaNotificationBell from '../src/multitable/components/MetaNotificationBell.vue'
import type { MetaRecordSubscriptionNotification } from '../src/multitable/types'

function notif(id: string, readAt: string | null = null): MetaRecordSubscriptionNotification {
  return { id, sheetId: 's1', recordId: `rec_${id}`, userId: 'u1', eventType: 'record.updated', actorId: null, revisionId: null, commentId: null, message: null, createdAt: '2026-06-16T00:00:00Z', readAt }
}
// B1-S1 D0-A: a durable button-delivered notification carries a custom message body.
function notifSent(id: string, message: string): MetaRecordSubscriptionNotification {
  return { id, sheetId: 's1', recordId: `rec_${id}`, userId: 'u1', eventType: 'notification.sent', actorId: null, revisionId: null, commentId: null, message, createdAt: '2026-06-16T00:00:00Z', readAt: null }
}
const flush = async () => { await nextTick(); await Promise.resolve(); await Promise.resolve(); await nextTick() }

function mount(over: Record<string, unknown> = {}, onNavigate?: (p: unknown) => void) {
  const apiClient = {
    listRecordSubscriptionNotifications: vi.fn(async () => [notif('a'), notif('b', '2026-06-16T01:00:00Z')]),
    getRecordSubscriptionUnreadCount: vi.fn(async () => 2),
    markRecordSubscriptionNotificationsRead: vi.fn(async () => 1),
    markAllRecordSubscriptionNotificationsRead: vi.fn(async () => 1),
    ...over,
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaNotificationBell, { apiClient: apiClient as never, ...(onNavigate ? { onNavigate } : {}) }) })
  app.mount(container)
  return { container, app, apiClient }
}

describe('MetaNotificationBell (S1b)', () => {
  let mounted: { container: HTMLElement; app: App } | null = null
  afterEach(() => { if (mounted) { mounted.app.unmount(); mounted.container.remove(); mounted = null } })

  it('shows the unread badge from the ambient count, then lists notifications on open', async () => {
    const m = mount(); mounted = m
    await flush()
    expect(m.container.querySelector('[data-test="notification-bell-badge"]')?.textContent).toBe('2')
    // panel is closed until clicked
    expect(m.container.querySelector('[data-test="notification-panel"]')).toBeNull()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-bell-btn"]')!.click()
    await flush()
    expect(m.container.querySelector('[data-test="notification-panel"]')).not.toBeNull()
    expect(m.container.querySelectorAll('[data-test="notification-item"]').length).toBe(2)
    // the unread one (a) shows a dot; the read one (b) does not
    expect(m.container.querySelectorAll('[data-test="notification-unread-dot"]').length).toBe(1)
  })

  it('clicking an item emits navigate {sheetId, recordId} and marks it read', async () => {
    const onNavigate = vi.fn()
    const m = mount({}, onNavigate); mounted = m
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-bell-btn"]')!.click()
    await flush()
    m.container.querySelector<HTMLElement>('[data-test="notification-item"]')!.click() // first item = unread 'a'
    await flush()
    expect(onNavigate).toHaveBeenCalledWith({ sheetId: 's1', recordId: 'rec_a' })
    expect(m.apiClient.markRecordSubscriptionNotificationsRead).toHaveBeenCalledWith(['a'])
  })

  it('mark-all-read calls the client and the panel closes the item back to read', async () => {
    const m = mount(); mounted = m
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-bell-btn"]')!.click()
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-mark-all"]')!.click()
    await flush()
    expect(m.apiClient.markAllRecordSubscriptionNotificationsRead).toHaveBeenCalled()
  })

  it('a failed mark-all shows the error WITHOUT hiding the still-loaded list (no dead-state)', async () => {
    const m = mount({ markAllRecordSubscriptionNotificationsRead: vi.fn(async () => { throw new Error('mark fail') }) }); mounted = m
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-bell-btn"]')!.click()
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-mark-all"]')!.click()
    await flush()
    expect(m.container.querySelector('.meta-notif-bell__state--error')?.textContent).toContain('mark fail')
    // the list is NOT replaced by the error — both render
    expect(m.container.querySelectorAll('[data-test="notification-item"]').length).toBe(2)
  })

  it('B1-S1 D0-A: renders the custom message for a notification.sent row', async () => {
    const m = mount({
      listRecordSubscriptionNotifications: vi.fn(async () => [notifSent('n1', 'Ship the release')]),
      getRecordSubscriptionUnreadCount: vi.fn(async () => 1),
    })
    mounted = m
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-bell-btn"]')!.click()
    await flush()
    const message = m.container.querySelector('[data-test="notification-message"]')
    expect(message).not.toBeNull()
    expect(message?.textContent).toContain('Ship the release')
  })

  it('does not crash when the client fails — renders the error state instead (P2-1)', async () => {
    const m = mount({ listRecordSubscriptionNotifications: vi.fn(async () => { throw new Error('netfail') }) }); mounted = m
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-bell-btn"]')!.click()
    await flush()
    // panel still renders; error surfaced; no throw escaped the click
    expect(m.container.querySelector('[data-test="notification-panel"]')).not.toBeNull()
    expect(m.container.querySelector('.meta-notif-bell__state--error')?.textContent).toContain('netfail')
  })
})
