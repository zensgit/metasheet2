import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaNotificationBell from '../src/multitable/components/MetaNotificationBell.vue'
import type { MetaRecordSubscriptionNotification } from '../src/multitable/types'

// UI-P2-1c T3 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T3, RATIFIED):
// MetaNotificationBell's mark-all-read control — the only sharer of the old `.meta-notif-bell__mark-all`
// class — is now <MtLink>. Bespoke #2563eb CSS removed (no double-styling). Behavior-preservation
// proof: it stays a native, keyboard-operable <button> (now class `mt-link`; `data-test` attr still
// falls through); clicking it still calls `markAllRecordSubscriptionNotificationsRead` on the injected
// client, same as pre-migration (mirrors meta-notification-bell.spec.ts's own mark-all assertion).

function notif(id: string, readAt: string | null = null): MetaRecordSubscriptionNotification {
  return { id, sheetId: 's1', recordId: `rec_${id}`, userId: 'u1', eventType: 'record.updated', actorId: null, revisionId: null, commentId: null, message: null, createdAt: '2026-06-16T00:00:00Z', readAt }
}
const flush = async () => { await nextTick(); await Promise.resolve(); await Promise.resolve(); await nextTick() }

function mount(over: Record<string, unknown> = {}) {
  const apiClient = {
    listRecordSubscriptionNotifications: vi.fn(async () => [notif('a'), notif('b')]),
    getRecordSubscriptionUnreadCount: vi.fn(async () => 2),
    markRecordSubscriptionNotificationsRead: vi.fn(async () => 1),
    markAllRecordSubscriptionNotificationsRead: vi.fn(async () => 1),
    ...over,
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaNotificationBell, { apiClient: apiClient as never }) })
  app.mount(container)
  return { container, app, apiClient }
}

describe('MetaNotificationBell — MtLink migration (UI-P2-1c T3)', () => {
  let mounted: { container: HTMLElement; app: App } | null = null
  afterEach(() => { if (mounted) { mounted.app.unmount(); mounted.container.remove(); mounted = null } })

  it('renders mark-all-read as a native <button class="mt-link">; bespoke class fully removed', async () => {
    const m = mount(); mounted = m
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-bell-btn"]')!.click()
    await flush()
    const btn = m.container.querySelector<HTMLButtonElement>('[data-test="notification-mark-all"]')!
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-link')).toBe(true)
    expect(m.container.querySelector('.meta-notif-bell__mark-all')).toBeNull() // bespoke class gone, not just unused
  })

  it('clicking it still calls markAllRecordSubscriptionNotificationsRead on the client (unchanged)', async () => {
    const m = mount(); mounted = m
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-bell-btn"]')!.click()
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-mark-all"]')!.click()
    await flush()
    expect(m.apiClient.markAllRecordSubscriptionNotificationsRead).toHaveBeenCalledTimes(1)
  })

  it('is only rendered while hasUnread is true (v-if survives the swap)', async () => {
    // Both seeded notifications already read → hasUnread false → the control never mounts.
    const m = mount({
      listRecordSubscriptionNotifications: vi.fn(async () => [notif('a', '2026-06-16T01:00:00Z'), notif('b', '2026-06-16T01:00:00Z')]),
      getRecordSubscriptionUnreadCount: vi.fn(async () => 0),
    })
    mounted = m
    await flush()
    m.container.querySelector<HTMLButtonElement>('[data-test="notification-bell-btn"]')!.click()
    await flush()
    expect(m.container.querySelector('[data-test="notification-mark-all"]')).toBeNull()
  })
})
