<template>
  <aside class="comments-panel" :class="{ 'comments-panel--disabled': !recordId }">
    <div class="comments-panel__header">
      <div class="comments-panel__title">评论</div>
      <div class="comments-panel__meta">
        <span v-if="recordId">记录: {{ recordId }}</span>
        <span v-if="fieldLabel">字段: {{ fieldLabel }}</span>
      </div>
    </div>

    <div class="comments-panel__filters">
      <button
        type="button"
        class="comments-panel__filter-btn"
        :class="resolvedFilter === 'open' ? 'is-active' : ''"
        @click="setResolvedFilter('open')"
      >
        未解决
      </button>
      <button
        type="button"
        class="comments-panel__filter-btn"
        :class="resolvedFilter === 'resolved' ? 'is-active' : ''"
        @click="setResolvedFilter('resolved')"
      >
        已解决
      </button>
      <button type="button" class="comments-panel__refresh" @click="refresh">刷新</button>
    </div>

    <div v-if="recordId && authMessage" class="comments-panel__auth">
      <div class="comments-panel__auth-title">{{ authMessage.title }}</div>
      <div v-if="authMessage.hint" class="comments-panel__auth-hint">{{ authMessage.hint }}</div>
    </div>

    <div v-if="!recordId" class="comments-panel__empty">
      请选择单元格以查看评论
    </div>

    <div v-else class="comments-panel__list">
      <div v-if="loading" class="comments-panel__loading">加载中...</div>
      <div v-else-if="items.length === 0" class="comments-panel__empty">暂无评论</div>
      <div v-else class="comments-panel__items">
        <div v-for="item in items" :key="item.id" class="comments-panel__item">
          <div class="comments-panel__item-head">
            <span class="comments-panel__author">{{ item.authorId }}</span>
            <span class="comments-panel__time">{{ formatTimestamp(item.createdAt) }}</span>
            <span v-if="item.resolved" class="comments-panel__tag">已解决</span>
          </div>
          <div class="comments-panel__content">{{ item.content }}</div>
          <div class="comments-panel__item-actions">
            <button
              v-if="!item.resolved"
              type="button"
              class="comments-panel__resolve"
              @click="resolveComment(item.id)"
            >
              解决
            </button>
          </div>
        </div>
      </div>
      <button
        v-if="items.length < total"
        type="button"
        class="comments-panel__load"
        :disabled="loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? '加载中...' : '加载更多' }}
      </button>
    </div>

    <form class="comments-panel__composer" @submit.prevent="submit">
      <textarea
        v-model="draft"
        class="comments-panel__input"
        rows="3"
        placeholder="输入评论..."
        :disabled="!recordId"
      />
      <button
        type="submit"
        class="comments-panel__submit"
        :disabled="!recordId || draft.trim().length === 0 || submitting"
      >
        {{ submitting ? '发送中...' : '发送' }}
      </button>
    </form>

    <div v-if="errorMessage" class="comments-panel__error">{{ errorMessage }}</div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { apiFetch, getApiBase } from '../utils/api'

const props = defineProps<{
  spreadsheetId: string
  recordId: string
  fieldId?: string
  fieldLabel?: string
}>()

const emit = defineEmits<{
  (event: 'comment-updated', payload: { rowId: string }): void
}>()

type CommentItem = {
  id: string
  spreadsheetId: string
  rowId: string
  fieldId?: string
  content: string
  authorId: string
  resolved: boolean
  createdAt: string
  updatedAt: string
}

const limit = 20
const items = ref<CommentItem[]>([])
const total = ref(0)
const offset = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const submitting = ref(false)
const errorMessage = ref('')
const authStatus = ref<'ok' | 'unauthorized' | 'forbidden'>('ok')
const draft = ref('')
const resolvedFilter = ref<'open' | 'resolved'>('open')

const resolvedValue = computed(() => resolvedFilter.value === 'resolved')
const isDev = import.meta.env.DEV
const authMessage = computed(() => {
  if (authStatus.value === 'unauthorized') {
    return {
      title: '未登录，无法查看评论',
      hint: isDev ? '请点击顶部 Dev Login 后重试' : '请登录后重试',
    }
  }
  if (authStatus.value === 'forbidden') {
    return {
      title: '权限不足，无法访问评论',
      hint: '需要 comments:read / comments:write 权限',
    }
  }
  return null
})
let socket: Socket | null = null
let joinedSheetId = ''

function setResolvedFilter(value: 'open' | 'resolved') {
  resolvedFilter.value = value
}

function setAuthError(status: 'unauthorized' | 'forbidden', fallback: string) {
  authStatus.value = status
  errorMessage.value = fallback
}

function formatTimestamp(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

async function fetchComments(reset = false) {
  if (!props.recordId || !props.spreadsheetId) {
    items.value = []
    total.value = 0
    offset.value = 0
    authStatus.value = 'ok'
    return
  }

  authStatus.value = 'ok'
  if (reset) {
    offset.value = 0
    items.value = []
  }

  loading.value = reset
  loadingMore.value = !reset
  errorMessage.value = ''

  try {
    const qs = new URLSearchParams({
      spreadsheetId: props.spreadsheetId,
      rowId: props.recordId,
      limit: String(limit),
      offset: String(offset.value),
      resolved: String(resolvedValue.value),
    })

    const res = await apiFetch(`/api/comments?${qs.toString()}`)
    if (res.status === 401) {
      setAuthError('unauthorized', '请登录后查看评论')
      return
    }
    if (res.status === 403) {
      setAuthError('forbidden', '无权限查看评论')
      return
    }
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.ok) {
      errorMessage.value = json.error?.message || '加载评论失败'
      return
    }

    const nextItems = Array.isArray(json.data?.items) ? (json.data.items as CommentItem[]) : []
    total.value = typeof json.data?.total === 'number' ? json.data.total : nextItems.length
    if (reset) {
      items.value = nextItems
    } else {
      items.value = items.value.concat(nextItems)
    }
    if (props.recordId) {
      emit('comment-updated', { rowId: props.recordId })
    }
  } catch (err) {
    errorMessage.value = (err as Error).message || '加载评论失败'
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadMore() {
  if (items.value.length >= total.value || loading.value || loadingMore.value) return
  offset.value += limit
  await fetchComments(false)
}

async function refresh() {
  await fetchComments(true)
}

async function submit() {
  if (!props.recordId || !props.spreadsheetId || submitting.value) return
  const content = draft.value.trim()
  if (!content) return

  authStatus.value = 'ok'
  submitting.value = true
  errorMessage.value = ''
  try {
    const res = await apiFetch('/api/comments', {
      method: 'POST',
      body: JSON.stringify({
        spreadsheetId: props.spreadsheetId,
        rowId: props.recordId,
        fieldId: props.fieldId,
        content,
      }),
    })
    if (res.status === 401) {
      setAuthError('unauthorized', '请登录后发送评论')
      return
    }
    if (res.status === 403) {
      setAuthError('forbidden', '无权限发送评论')
      return
    }
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.ok) {
      errorMessage.value = json.error?.message || '发送失败'
      return
    }
    draft.value = ''
    await fetchComments(true)
  } catch (err) {
    errorMessage.value = (err as Error).message || '发送失败'
  } finally {
    submitting.value = false
  }
}

async function resolveComment(commentId: string) {
  if (!commentId) return
  authStatus.value = 'ok'
  errorMessage.value = ''
  try {
    const res = await apiFetch(`/api/comments/${commentId}/resolve`, { method: 'POST' })
    if (res.status === 401) {
      setAuthError('unauthorized', '请登录后处理评论')
      return
    }
    if (res.status === 403) {
      setAuthError('forbidden', '无权限处理评论')
      return
    }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      errorMessage.value = json.error?.message || '处理失败'
      return
    }
    await fetchComments(true)
  } catch (err) {
    errorMessage.value = (err as Error).message || '处理失败'
  }
}

function syncSheetRoom(nextSheetId: string) {
  if (!socket) return
  if (joinedSheetId && joinedSheetId !== nextSheetId) {
    socket.emit('leave-sheet', joinedSheetId)
  }
  if (nextSheetId && joinedSheetId !== nextSheetId) {
    socket.emit('join-sheet', nextSheetId)
  }
  joinedSheetId = nextSheetId
}

function handleCommentCreated(payload: any) {
  if (!payload || payload.spreadsheetId !== props.spreadsheetId) return
  const rowId = payload.comment?.rowId
  if (rowId) {
    emit('comment-updated', { rowId })
  }
  if (!rowId || rowId !== props.recordId) return
  refresh()
}

function handleCommentResolved(payload: any) {
  if (!payload || payload.spreadsheetId !== props.spreadsheetId) return
  const rowId = payload.rowId
  if (rowId) {
    emit('comment-updated', { rowId })
  }
  if (!props.recordId || !rowId || rowId !== props.recordId) return
  refresh()
}

function connectSocket() {
  if (socket) return
  const base = getApiBase()
  socket = io(base, { path: '/socket.io' })
  socket.on('connect', () => {
    if (props.spreadsheetId) syncSheetRoom(props.spreadsheetId)
  })
  socket.on('comment:created', handleCommentCreated)
  socket.on('comment:resolved', handleCommentResolved)
}

function disconnectSocket() {
  if (!socket) return
  socket.off('comment:created', handleCommentCreated)
  socket.off('comment:resolved', handleCommentResolved)
  socket.disconnect()
  socket = null
  joinedSheetId = ''
}

watch(
  () => [props.spreadsheetId, props.recordId, props.fieldId, resolvedFilter.value],
  () => {
    fetchComments(true)
  },
  { immediate: true }
)

watch(
  () => props.spreadsheetId,
  (nextSheetId) => {
    if (socket) syncSheetRoom(nextSheetId)
  }
)

onMounted(() => {
  connectSocket()
})

onUnmounted(() => {
  disconnectSocket()
})
</script>

<style scoped>
.comments-panel {
  width: 280px;
  border-left: 1px solid #e5e7eb;
  background: #fafafa;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.comments-panel--disabled {
  opacity: 0.75;
}

.comments-panel__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.comments-panel__title {
  font-weight: 600;
  color: #111827;
}

.comments-panel__meta {
  font-size: 12px;
  color: #6b7280;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.comments-panel__filters {
  display: flex;
  align-items: center;
  gap: 6px;
}

.comments-panel__filter-btn {
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  color: #6b7280;
}

.comments-panel__filter-btn.is-active {
  border-color: #1677ff;
  color: #1677ff;
}

.comments-panel__refresh {
  margin-left: auto;
  border: none;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
  color: #1677ff;
}

.comments-panel__list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.comments-panel__items {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.comments-panel__item {
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 10px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.comments-panel__item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #6b7280;
}

.comments-panel__author {
  font-weight: 600;
  color: #111827;
}

.comments-panel__time {
  margin-left: auto;
}

.comments-panel__tag {
  border: 1px solid #bbf7d0;
  background: #ecfdf3;
  color: #0f766e;
  border-radius: 999px;
  padding: 2px 6px;
  font-size: 11px;
}

.comments-panel__content {
  font-size: 13px;
  color: #111827;
  white-space: pre-wrap;
}

.comments-panel__item-actions {
  display: flex;
  justify-content: flex-end;
}

.comments-panel__resolve {
  border: none;
  background: #1677ff;
  color: #fff;
  font-size: 12px;
  border-radius: 8px;
  padding: 4px 10px;
  cursor: pointer;
}

.comments-panel__composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.comments-panel__input {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 8px;
  font-size: 12px;
  resize: vertical;
}

.comments-panel__submit {
  align-self: flex-end;
  border: none;
  background: #1677ff;
  color: #fff;
  font-size: 12px;
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}

.comments-panel__empty {
  font-size: 12px;
  color: #9ca3af;
}

.comments-panel__loading {
  font-size: 12px;
  color: #6b7280;
}

.comments-panel__load {
  border: 1px dashed #e5e7eb;
  background: #fff;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  color: #6b7280;
}

.comments-panel__auth {
  border: 1px solid #fde68a;
  background: #fffbeb;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  color: #92400e;
}

.comments-panel__auth-title {
  font-weight: 600;
}

.comments-panel__auth-hint {
  margin-top: 4px;
  color: #b45309;
}

.comments-panel__error {
  font-size: 12px;
  color: #dc2626;
}
</style>
