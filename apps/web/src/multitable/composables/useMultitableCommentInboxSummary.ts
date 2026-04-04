import { computed, ref } from 'vue'
import type { CommentMentionSummary } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'
import type {
  MultitableCommentCreatedEvent,
  MultitableCommentResolvedEvent,
} from '../realtime/comments-realtime'

export function useMultitableCommentInboxSummary(opts?: {
  client?: MultitableApiClient
}) {
  const client = opts?.client ?? multitableClient

  const summary = ref<CommentMentionSummary | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let lastMarkedReadAt: number | null = null

  const unreadMentionCount = computed(() => summary.value?.unreadMentionCount ?? 0)
  const unreadRecordCount = computed(() => summary.value?.unreadRecordCount ?? 0)

  async function loadSummary(params: { spreadsheetId: string }) {
    if (!params.spreadsheetId) {
      summary.value = null
      return
    }
    loading.value = true
    error.value = null
    try {
      summary.value = await client.loadMentionSummary({ spreadsheetId: params.spreadsheetId })
      lastMarkedReadAt = null
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load mention summary'
      summary.value = null
    } finally {
      loading.value = false
    }
  }

  async function markRead(params: { spreadsheetId: string }) {
    if (!params.spreadsheetId) return
    try {
      await client.markMentionsRead({ spreadsheetId: params.spreadsheetId })
      lastMarkedReadAt = Date.now()
      if (summary.value && summary.value.spreadsheetId === params.spreadsheetId) {
        summary.value = {
          ...summary.value,
          unreadMentionCount: 0,
          unreadRecordCount: 0,
          items: summary.value.items.map((item) => ({ ...item, unreadCount: 0 })),
        }
      }
    } catch {
      // Reconcile on the next successful refresh.
    }
  }

  function clearSummary() {
    summary.value = null
    error.value = null
    lastMarkedReadAt = null
  }

  function resolveEventCreatedAt(event: MultitableCommentCreatedEvent): number | null {
    const createdAt = event.comment?.createdAt
    if (typeof createdAt !== 'string' || !createdAt.trim()) return null
    const timestamp = Date.parse(createdAt)
    return Number.isNaN(timestamp) ? null : timestamp
  }

  function onRealtimeCommentCreated(event: MultitableCommentCreatedEvent) {
    if (!summary.value) return
    const eventSpreadsheetId = event.spreadsheetId ?? event.comment?.containerId ?? ''
    if (eventSpreadsheetId !== summary.value.spreadsheetId) return
    const createdAt = resolveEventCreatedAt(event)
    if (lastMarkedReadAt !== null && createdAt !== null && createdAt <= lastMarkedReadAt) return

    const rowId = event.comment?.targetId ?? event.comment?.rowId ?? ''
    if (!rowId) return

    const existingItem = summary.value.items.find((item) => item.rowId === rowId)
    if (existingItem) {
      summary.value = {
        ...summary.value,
        unresolvedMentionCount: summary.value.unresolvedMentionCount + 1,
        unreadMentionCount: summary.value.unreadMentionCount + 1,
        unreadRecordCount: existingItem.unreadCount === 0
          ? summary.value.unreadRecordCount + 1
          : summary.value.unreadRecordCount,
        items: summary.value.items.map((item) =>
          item.rowId === rowId
            ? { ...item, mentionedCount: item.mentionedCount + 1, unreadCount: item.unreadCount + 1 }
            : item,
        ),
      }
      return
    }

    summary.value = {
      ...summary.value,
      unresolvedMentionCount: summary.value.unresolvedMentionCount + 1,
      unreadMentionCount: summary.value.unreadMentionCount + 1,
      mentionedRecordCount: summary.value.mentionedRecordCount + 1,
      unreadRecordCount: summary.value.unreadRecordCount + 1,
      items: [
        ...summary.value.items,
        { rowId, mentionedCount: 1, unreadCount: 1, mentionedFieldIds: [] },
      ],
    }
  }

  function onRealtimeCommentResolved(event: MultitableCommentResolvedEvent) {
    if (!summary.value) return
    if (event.spreadsheetId !== summary.value.spreadsheetId) return

    const rowId = event.rowId ?? ''
    if (!rowId) return

    const existingItem = summary.value.items.find((item) => item.rowId === rowId)
    if (!existingItem || existingItem.mentionedCount <= 0) return

    const nextMentionedCount = Math.max(0, existingItem.mentionedCount - 1)
    const nextUnreadCount = Math.max(0, existingItem.unreadCount - 1)

    if (nextMentionedCount === 0) {
      summary.value = {
        ...summary.value,
        unresolvedMentionCount: Math.max(0, summary.value.unresolvedMentionCount - 1),
        unreadMentionCount: Math.max(0, summary.value.unreadMentionCount - (existingItem.unreadCount > 0 ? 1 : 0)),
        mentionedRecordCount: Math.max(0, summary.value.mentionedRecordCount - 1),
        unreadRecordCount: existingItem.unreadCount > 0
          ? Math.max(0, summary.value.unreadRecordCount - 1)
          : summary.value.unreadRecordCount,
        items: summary.value.items.filter((item) => item.rowId !== rowId),
      }
      return
    }

    summary.value = {
      ...summary.value,
      unresolvedMentionCount: Math.max(0, summary.value.unresolvedMentionCount - 1),
      unreadMentionCount: existingItem.unreadCount > 0
        ? Math.max(0, summary.value.unreadMentionCount - 1)
        : summary.value.unreadMentionCount,
      unreadRecordCount: nextUnreadCount === 0 && existingItem.unreadCount > 0
        ? Math.max(0, summary.value.unreadRecordCount - 1)
        : summary.value.unreadRecordCount,
      items: summary.value.items.map((item) =>
        item.rowId === rowId
          ? { ...item, mentionedCount: nextMentionedCount, unreadCount: nextUnreadCount }
          : item,
      ),
    }
  }

  return {
    summary,
    loading,
    error,
    unreadMentionCount,
    unreadRecordCount,
    loadSummary,
    markRead,
    clearSummary,
    onRealtimeCommentCreated,
    onRealtimeCommentResolved,
  }
}
