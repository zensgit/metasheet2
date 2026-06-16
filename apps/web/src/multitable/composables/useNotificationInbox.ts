// Notification Center S1 — watcher-notification inbox state for the workbench bell.
// Mirrors useMultitableCommentInbox: a list + an unread badge count + self-scoped mark-read actions
// over the existing meta_record_subscription_notifications rows (read-state only; no delivery/prefs).
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MetaRecordSubscriptionNotification, MetaRecordSubscriptionNotificationType } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'
import { recordLabel } from '../utils/meta-record-labels'

export function useNotificationInbox(client?: MultitableApiClient) {
  const api = client ?? multitableClient
  const { isZh } = useLocale()
  const notifications = ref<MetaRecordSubscriptionNotification[]>([])
  const unreadCount = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const busyIds = ref<string[]>([])

  const hasUnread = computed(() => unreadCount.value > 0)

  function eventLabel(eventType: MetaRecordSubscriptionNotificationType): string {
    return eventType === 'comment.created'
      ? recordLabel('notification.eventCommentCreated', isZh.value)
      : recordLabel('notification.eventRecordUpdated', isZh.value)
  }

  // UI-facing actions NEVER throw — they surface failure via `error` and resolve. The bell is ambient
  // toolbar chrome; a rejected click would leak as an unhandled rejection / Vue console error.
  async function loadInbox(params?: { limit?: number; offset?: number }): Promise<MetaRecordSubscriptionNotification[]> {
    loading.value = true
    error.value = null
    try {
      const items = await api.listRecordSubscriptionNotifications(params)
      notifications.value = items
      return items
    } catch (e: any) {
      error.value = e?.message ?? recordLabel('notification.loadError', isZh.value)
      return notifications.value
    } finally {
      loading.value = false
    }
  }

  // Badge refresh is intentionally non-fatal: a transient failure keeps the prior count rather than
  // flashing an error on the toolbar (the bell is ambient chrome, not a primary action).
  async function refreshUnreadCount(): Promise<number> {
    try {
      unreadCount.value = await api.getRecordSubscriptionUnreadCount()
    } catch {
      /* keep prior count */
    }
    return unreadCount.value
  }

  async function markRead(ids: string[]): Promise<void> {
    const targets = ids.filter((id) => id && !busyIds.value.includes(id))
    if (targets.length === 0) return
    error.value = null // clear any prior failure so a successful action recovers the panel
    busyIds.value = [...busyIds.value, ...targets]
    try {
      await api.markRecordSubscriptionNotificationsRead(targets)
      const now = new Date().toISOString()
      const set = new Set(targets)
      notifications.value = notifications.value.map((n) => (set.has(n.id) && !n.readAt ? { ...n, readAt: now } : n))
      await refreshUnreadCount()
    } catch (e: any) {
      // swallow — never reject a click handler (would be an unhandled rejection / console error)
      error.value = e?.message ?? recordLabel('notification.loadError', isZh.value)
    } finally {
      const done = new Set(targets)
      busyIds.value = busyIds.value.filter((id) => !done.has(id))
    }
  }

  async function markAllRead(): Promise<void> {
    error.value = null // clear any prior failure so a successful action recovers the panel
    try {
      await api.markAllRecordSubscriptionNotificationsRead()
      const now = new Date().toISOString()
      notifications.value = notifications.value.map((n) => (n.readAt ? n : { ...n, readAt: now }))
      unreadCount.value = 0
    } catch (e: any) {
      error.value = e?.message ?? recordLabel('notification.loadError', isZh.value)
    }
  }

  function isBusy(id: string): boolean {
    return busyIds.value.includes(id)
  }

  return { notifications, unreadCount, loading, error, hasUnread, eventLabel, loadInbox, refreshUnreadCount, markRead, markAllRead, isBusy }
}
