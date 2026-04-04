import { computed, ref } from 'vue'
import type { MultitableCommentInboxItem, MultitableCommentInboxPage } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'

export function useMultitableCommentInbox(client?: MultitableApiClient) {
  const api = client ?? multitableClient
  const inbox = ref<MultitableCommentInboxItem[]>([])
  const total = ref(0)
  const unreadCount = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const busyIds = ref<string[]>([])

  const hasUnread = computed(() => unreadCount.value > 0)

  async function loadInbox(params?: { limit?: number; offset?: number }): Promise<MultitableCommentInboxPage> {
    loading.value = true
    error.value = null
    try {
      const page = await api.listCommentInbox(params)
      inbox.value = page.items
      total.value = page.total
      return page
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load comment inbox'
      throw e
    } finally {
      loading.value = false
    }
  }

  async function refreshUnreadCount(): Promise<number> {
    try {
      unreadCount.value = await api.getCommentUnreadCount()
      return unreadCount.value
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load unread comment count'
      throw e
    }
  }

  async function refreshInbox(params?: { limit?: number; offset?: number }): Promise<void> {
    const page = await loadInbox(params)
    unreadCount.value = await api.getCommentUnreadCount()
    if (page.items.length > 0 && unreadCount.value === 0) {
      unreadCount.value = page.items.filter((item) => item.unread).length
    }
  }

  async function markCommentRead(commentId: string): Promise<void> {
    if (busyIds.value.includes(commentId)) return
    busyIds.value = [...busyIds.value, commentId]
    error.value = null
    try {
      await api.markCommentRead(commentId)
      const nextItems: MultitableCommentInboxItem[] = inbox.value.map((item) =>
        item.id === commentId ? { ...item, unread: false } : item,
      )
      inbox.value = nextItems
      unreadCount.value = nextItems.filter((item) => item.unread).length
    } catch (e: any) {
      error.value = e.message ?? 'Failed to mark comment as read'
      throw e
    } finally {
      busyIds.value = busyIds.value.filter((id) => id !== commentId)
    }
  }

  function clearInbox() {
    inbox.value = []
    total.value = 0
    unreadCount.value = 0
    error.value = null
    busyIds.value = []
  }

  return {
    inbox,
    items: inbox,
    total,
    unreadCount,
    loading,
    error,
    busyIds,
    markingIds: busyIds,
    hasUnread,
    loadInbox,
    refreshInbox,
    refreshUnreadCount,
    markCommentRead,
    markRead: markCommentRead,
    clearInbox,
  }
}
