<template>
  <section class="mt-comment-inbox">
    <header class="mt-comment-inbox__header">
      <div>
        <h1>Multitable Comment Inbox</h1>
        <p>Mentions and unread comments from other collaborators, pulled from <code>/api/comments/inbox</code>.</p>
      </div>
      <button class="mt-comment-inbox__refresh" type="button" :disabled="loading" @click="() => void refreshInbox()">
        {{ loading ? 'Refreshing...' : 'Refresh' }}
      </button>
    </header>

    <div class="mt-comment-inbox__stats">
      <article class="mt-comment-inbox__stat">
        <strong>{{ unreadCount }}</strong>
        <span>Unread</span>
      </article>
      <article class="mt-comment-inbox__stat">
        <strong>{{ total }}</strong>
        <span>Total</span>
      </article>
      <article class="mt-comment-inbox__stat">
        <strong>{{ inbox.length }}</strong>
        <span>Loaded</span>
      </article>
    </div>

    <p v-if="error" class="mt-comment-inbox__error">{{ error }}</p>
    <div v-else-if="loading" class="mt-comment-inbox__empty">Loading comment inbox...</div>
    <div v-else-if="!inbox.length" class="mt-comment-inbox__empty">No comments in inbox yet.</div>
    <div v-else class="mt-comment-inbox__list">
      <article v-for="item in inbox" :key="item.id" class="mt-comment-inbox__card" :class="{ 'mt-comment-inbox__card--unread': item.unread }">
        <div class="mt-comment-inbox__card-head">
          <div>
            <strong>{{ item.authorName ?? item.authorId }}</strong>
            <p class="mt-comment-inbox__meta">
              <span v-if="item.baseId">Base {{ item.baseId }}</span>
              <span>Sheet {{ resolveItemSheetId(item) }}</span>
              <span>Row {{ resolveItemRecordId(item) }}</span>
              <span v-if="item.viewId">View {{ item.viewId }}</span>
              <span v-if="resolveItemFieldId(item)">Field {{ resolveItemFieldId(item) }}</span>
            </p>
          </div>
          <div class="mt-comment-inbox__flags">
            <span v-if="item.mentioned" class="mt-comment-inbox__badge mt-comment-inbox__badge--mention">Mention</span>
            <span v-if="item.unread" class="mt-comment-inbox__badge mt-comment-inbox__badge--unread">Unread</span>
            <span v-if="item.resolved" class="mt-comment-inbox__badge">Resolved</span>
          </div>
        </div>

        <p class="mt-comment-inbox__content">{{ item.content }}</p>
        <div class="mt-comment-inbox__footer">
          <span>{{ formatTime(item.createdAt) }}</span>
          <div class="mt-comment-inbox__actions">
            <button class="mt-comment-inbox__button" type="button" :disabled="openingId === item.id" @click="onOpen(item.id)">
              {{ openingId === item.id ? 'Opening...' : 'Open' }}
            </button>
            <button class="mt-comment-inbox__button" type="button" :disabled="!item.unread || busyIds.includes(item.id) || openingId === item.id" @click="onMarkRead(item.id)">
              {{ busyIds.includes(item.id) ? 'Saving...' : item.unread ? 'Mark read' : 'Read' }}
            </button>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMultitableCommentInbox } from '../multitable/composables/useMultitableCommentInbox'
import { useMultitableCommentInboxRealtime } from '../multitable/composables/useMultitableCommentInboxRealtime'
import { multitableClient } from '../multitable/api/client'
import type { MultitableCommentInboxItem } from '../multitable/types'
import { AppRouteNames } from '../router/types'

const inboxState = useMultitableCommentInbox(multitableClient)
const busyIds = ref<string[]>([])
const openingId = ref<string | null>(null)
const router = useRouter()

const {
  inbox,
  unreadCount,
  total,
  loading,
  error,
  refreshInbox,
  markCommentRead,
} = inboxState

useMultitableCommentInboxRealtime({
  refreshInbox: async () => {
    await refreshInbox()
  },
})

async function onMarkRead(commentId: string) {
  if (busyIds.value.includes(commentId)) return
  busyIds.value = [...busyIds.value, commentId]
  try {
    await markCommentRead(commentId)
    await refreshInbox()
  } finally {
    busyIds.value = busyIds.value.filter((id) => id !== commentId)
  }
}

async function onOpen(commentId: string) {
  const item = inbox.value.find((entry) => entry.id === commentId)
  if (!item || openingId.value === commentId) return

  openingId.value = commentId
  try {
    const resolvedSheetId = resolveItemSheetId(item)
    let resolvedBaseId = item.baseId ?? undefined
    let resolvedViewId = item.viewId ?? undefined
    const resolvedRecordId = resolveItemRecordId(item)
    const resolvedFieldId = resolveItemFieldId(item) ?? undefined

    if (!resolvedViewId) {
      const context = await multitableClient.loadContext({ sheetId: resolvedSheetId })
      resolvedBaseId = resolvedBaseId ?? context.base?.id ?? undefined
      resolvedViewId = context.views[0]?.id
    }

    if (!resolvedViewId) {
      throw new Error('No multitable view is available for this sheet yet.')
    }
    await router.push({
      name: AppRouteNames.MULTITABLE,
      params: {
        sheetId: resolvedSheetId,
        viewId: resolvedViewId,
      },
      query: {
        baseId: resolvedBaseId,
        recordId: resolvedRecordId,
        commentId: item.id,
        fieldId: resolvedFieldId,
        openComments: 'true',
      },
    })
    if (item.unread) {
      await onMarkRead(item.id)
    }
  } catch (error: any) {
    const message = error?.message ?? 'Failed to open comment'
    console.warn('[multitable-comment-inbox] open failed', error)
    inboxState.error.value = message
  } finally {
    openingId.value = null
  }
}

function resolveItemSheetId(item: MultitableCommentInboxItem): string {
  return item.sheetId ?? item.spreadsheetId ?? item.containerId
}

function resolveItemRecordId(item: MultitableCommentInboxItem): string {
  return item.recordId ?? item.rowId ?? item.targetId
}

function resolveItemFieldId(item: MultitableCommentInboxItem): string | null {
  return item.targetFieldId ?? item.fieldId ?? null
}

function formatTime(value: string): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

onMounted(() => {
  void refreshInbox()
})
</script>

<style scoped>
.mt-comment-inbox {
  max-width: 1120px;
  margin: 0 auto;
  padding: 24px 20px 40px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.mt-comment-inbox__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.mt-comment-inbox__header h1 {
  margin: 0 0 8px;
  font-size: 28px;
}

.mt-comment-inbox__header p {
  margin: 0;
  color: #6b7280;
}

.mt-comment-inbox__refresh,
.mt-comment-inbox__button {
  border: none;
  border-radius: 999px;
  padding: 8px 14px;
  cursor: pointer;
}

.mt-comment-inbox__refresh {
  background: linear-gradient(135deg, #4f7cff, #6f63ff);
  color: #fff;
}

.mt-comment-inbox__stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.mt-comment-inbox__stat,
.mt-comment-inbox__card {
  border: 1px solid #e6e8ef;
  border-radius: 16px;
  background: #fff;
}

.mt-comment-inbox__stat {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mt-comment-inbox__stat strong {
  font-size: 24px;
}

.mt-comment-inbox__stat span {
  color: #6b7280;
  font-size: 13px;
}

.mt-comment-inbox__error,
.mt-comment-inbox__empty {
  padding: 18px;
  border-radius: 16px;
  background: #f8fafc;
  color: #475569;
}

.mt-comment-inbox__list {
  display: grid;
  gap: 12px;
}

.mt-comment-inbox__card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mt-comment-inbox__card--unread {
  border-color: #9eb5ff;
  box-shadow: 0 8px 20px rgba(79, 124, 255, 0.08);
}

.mt-comment-inbox__card-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.mt-comment-inbox__meta {
  margin: 6px 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: #6b7280;
  font-size: 12px;
}

.mt-comment-inbox__flags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mt-comment-inbox__badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: #edf2ff;
  color: #3853c7;
  padding: 4px 10px;
  font-size: 12px;
}

.mt-comment-inbox__badge--unread {
  background: #e0ecff;
}

.mt-comment-inbox__badge--mention {
  background: #dcfce7;
  color: #166534;
}

.mt-comment-inbox__content {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
}

.mt-comment-inbox__footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: #6b7280;
}

.mt-comment-inbox__actions {
  display: flex;
  gap: 8px;
}

.mt-comment-inbox__button {
  background: #111827;
  color: #fff;
}

.mt-comment-inbox__button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .mt-comment-inbox__header,
  .mt-comment-inbox__card-head,
  .mt-comment-inbox__footer {
    flex-direction: column;
  }

  .mt-comment-inbox__stats {
    grid-template-columns: 1fr;
  }
}
</style>
