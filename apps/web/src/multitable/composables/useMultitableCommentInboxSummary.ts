import { computed, ref } from 'vue'
import { useAuth } from '../../composables/useAuth'
import type { CommentMentionSummary } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'
import {
  normalizeMultitableCommentMutationEvent,
  normalizeMultitableCommentRealtimeEvent,
  type MultitableCommentCreatedEvent,
  type MultitableCommentDeletedEvent,
  type MultitableCommentUpdatedEvent,
  type MultitableCommentResolvedEvent,
} from '../realtime/comments-realtime'

export function useMultitableCommentInboxSummary(opts?: {
  client?: MultitableApiClient
}) {
  const auth = useAuth()
  const client = opts?.client ?? multitableClient

  const summary = ref<CommentMentionSummary | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let lastMarkedReadAt: number | null = null
  let activeSpreadsheetId: string | null = null
  let currentUserIdCache: string | null | undefined
  let currentUserIdPromise: Promise<string | null> | null = null
  let refreshInFlight = false
  let queuedRefreshSpreadsheetId: string | null = null

  const unreadMentionCount = computed(() => summary.value?.unreadMentionCount ?? 0)
  const unreadRecordCount = computed(() => summary.value?.unreadRecordCount ?? 0)

  async function resolveCurrentUserId(): Promise<string | null> {
    if (currentUserIdCache !== undefined) return currentUserIdCache
    if (currentUserIdPromise) return currentUserIdPromise

    currentUserIdPromise = auth.getCurrentUserId().catch(() => null)
    try {
      currentUserIdCache = await currentUserIdPromise
      return currentUserIdCache
    } finally {
      currentUserIdPromise = null
    }
  }

  async function loadSummary(params: { spreadsheetId: string }) {
    if (!params.spreadsheetId) {
      activeSpreadsheetId = null
      summary.value = null
      return
    }
    activeSpreadsheetId = params.spreadsheetId
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

  async function queueSummaryRefresh(spreadsheetId: string) {
    if (!spreadsheetId) return

    queuedRefreshSpreadsheetId = spreadsheetId
    if (refreshInFlight) return

    while (queuedRefreshSpreadsheetId) {
      const nextSpreadsheetId = queuedRefreshSpreadsheetId
      queuedRefreshSpreadsheetId = null
      if (!nextSpreadsheetId || activeSpreadsheetId !== nextSpreadsheetId) continue
      refreshInFlight = true
      try {
        await loadSummary({ spreadsheetId: nextSpreadsheetId })
      } finally {
        refreshInFlight = false
      }
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
    activeSpreadsheetId = null
    queuedRefreshSpreadsheetId = null
    summary.value = null
    error.value = null
    lastMarkedReadAt = null
  }

  function mergeMentionedFieldIds(existingFieldIds: string[], fieldId: string | null): string[] {
    if (!fieldId || existingFieldIds.includes(fieldId)) return existingFieldIds
    return [...existingFieldIds, fieldId]
  }

  async function reconcileRealtimeCommentCreated(event: MultitableCommentCreatedEvent) {
    const currentSummary = summary.value
    if (!currentSummary) return

    const normalizedEvent = normalizeMultitableCommentRealtimeEvent(event)
    if (!normalizedEvent || normalizedEvent.spreadsheetId !== currentSummary.spreadsheetId) return
    const { comment } = normalizedEvent

    const currentUserId = await resolveCurrentUserId()
    if (!currentUserId) return
    if (!comment.mentions.includes(currentUserId)) return

    const latestSummary = summary.value
    if (!latestSummary || latestSummary.spreadsheetId !== normalizedEvent.spreadsheetId) return

    const createdAt = comment.createdAt ? Date.parse(comment.createdAt) : null
    if (lastMarkedReadAt !== null && createdAt !== null && createdAt <= lastMarkedReadAt) return

    const fieldId = comment.fieldId ?? null
    const existingItem = latestSummary.items.find((item) => item.rowId === comment.targetId)

    if (existingItem) {
      summary.value = {
        ...latestSummary,
        unresolvedMentionCount: latestSummary.unresolvedMentionCount + 1,
        unreadMentionCount: latestSummary.unreadMentionCount + 1,
        unreadRecordCount: existingItem.unreadCount === 0
          ? latestSummary.unreadRecordCount + 1
          : latestSummary.unreadRecordCount,
        items: latestSummary.items.map((item) =>
          item.rowId === comment.targetId
            ? {
                ...item,
                mentionedCount: item.mentionedCount + 1,
                unreadCount: item.unreadCount + 1,
                mentionedFieldIds: mergeMentionedFieldIds(item.mentionedFieldIds, fieldId),
              }
            : item,
        ),
      }
      return
    }

    summary.value = {
      ...latestSummary,
      unresolvedMentionCount: latestSummary.unresolvedMentionCount + 1,
      unreadMentionCount: latestSummary.unreadMentionCount + 1,
      mentionedRecordCount: latestSummary.mentionedRecordCount + 1,
      unreadRecordCount: latestSummary.unreadRecordCount + 1,
      items: [
        ...latestSummary.items,
        { rowId: comment.targetId, mentionedCount: 1, unreadCount: 1, mentionedFieldIds: fieldId ? [fieldId] : [] },
      ],
    }
  }

  function onRealtimeCommentCreated(event: MultitableCommentCreatedEvent) {
    void reconcileRealtimeCommentCreated(event)
  }

  function onRealtimeCommentResolved(event: MultitableCommentResolvedEvent) {
    const currentSummary = summary.value
    if (!currentSummary) return

    const normalizedEvent = normalizeMultitableCommentMutationEvent(event)
    if (!normalizedEvent || normalizedEvent.spreadsheetId !== currentSummary.spreadsheetId) return

    const existingItem = currentSummary.items.find((item) => item.rowId === normalizedEvent.rowId)
    if (!existingItem) return

    void queueSummaryRefresh(currentSummary.spreadsheetId)
  }

  function onRealtimeCommentUpdated(event: MultitableCommentUpdatedEvent) {
    const currentSummary = summary.value
    if (!currentSummary) return
    const normalizedEvent = normalizeMultitableCommentRealtimeEvent(event)
    if (!normalizedEvent || normalizedEvent.spreadsheetId !== currentSummary.spreadsheetId) return
    void queueSummaryRefresh(currentSummary.spreadsheetId)
  }

  function onRealtimeCommentDeleted(event: MultitableCommentDeletedEvent) {
    const currentSummary = summary.value
    if (!currentSummary) return
    const normalizedEvent = normalizeMultitableCommentMutationEvent(event)
    if (!normalizedEvent || normalizedEvent.spreadsheetId !== currentSummary.spreadsheetId) return
    void queueSummaryRefresh(currentSummary.spreadsheetId)
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
    onRealtimeCommentUpdated,
    onRealtimeCommentResolved,
    onRealtimeCommentDeleted,
  }
}
