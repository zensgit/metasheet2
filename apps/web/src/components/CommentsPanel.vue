<template>
  <aside class="comments-panel">
    <header class="comments-panel__header">
      <div class="comments-panel__title">评论</div>
      <div class="comments-panel__meta">
        <span v-if="fieldLabel">{{ fieldLabel }}</span>
        <span v-else-if="fieldId">{{ fieldId }}</span>
      </div>
    </header>

    <div v-if="!spreadsheetId || !recordId" class="comments-panel__empty">
      选择一行后查看评论
    </div>

    <div v-else class="comments-panel__body">
      <div v-if="loading" class="comments-panel__status">加载中...</div>
      <div v-else-if="error" class="comments-panel__status comments-panel__status--error">{{ error }}</div>
      <div v-else-if="comments.length === 0" class="comments-panel__status">暂无评论</div>
      <ul v-else class="comments-panel__list">
        <li v-for="comment in comments" :key="comment.id" class="comments-panel__item">
          <div class="comments-panel__content">{{ comment.content }}</div>
          <div class="comments-panel__meta-row">
            <span>{{ comment.authorId || 'anonymous' }}</span>
            <span>{{ formatTime(comment.createdAt) }}</span>
          </div>
        </li>
      </ul>
    </div>

    <form v-if="spreadsheetId && recordId" class="comments-panel__form" @submit.prevent="submitComment">
      <textarea v-model="draft" placeholder="输入评论..." rows="3" />
      <button type="submit" :disabled="submitting || !draft.trim()">发送</button>
    </form>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiFetch } from '../utils/api'

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
  content: string
  authorId?: string
  createdAt?: string
}

const comments = ref<CommentItem[]>([])
const loading = ref(false)
const error = ref('')
const draft = ref('')
const submitting = ref(false)

const canLoad = computed(() => props.spreadsheetId && props.recordId)

async function loadComments() {
  if (!canLoad.value) {
    comments.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams({
      spreadsheetId: props.spreadsheetId,
      rowId: props.recordId,
      limit: '50',
      offset: '0',
    })
    const res = await apiFetch(`/api/comments?${qs.toString()}`)
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      data?: { items?: Array<{ id?: string; content?: string; authorId?: string; createdAt?: string }> }
      error?: { message?: string }
    }
    if (!res.ok || !json.ok) {
      throw new Error(json.error?.message || `加载失败 (${res.status})`)
    }
    const items = json.data?.items ?? []
    comments.value = items.map((item) => ({
      id: String(item.id ?? ''),
      content: String(item.content ?? ''),
      authorId: item.authorId ? String(item.authorId) : undefined,
      createdAt: item.createdAt ? String(item.createdAt) : undefined,
    }))
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    comments.value = []
  } finally {
    loading.value = false
  }
}

async function submitComment() {
  if (!canLoad.value || !draft.value.trim()) return
  submitting.value = true
  try {
    const payload = {
      spreadsheetId: props.spreadsheetId,
      rowId: props.recordId,
      fieldId: props.fieldId,
      content: draft.value.trim(),
    }
    const res = await apiFetch('/api/comments', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { message?: string } }
    if (!res.ok || !json.ok) {
      throw new Error(json.error?.message || `提交失败 (${res.status})`)
    }
    draft.value = ''
    emit('comment-updated', { rowId: props.recordId })
    await loadComments()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}

function formatTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

watch(
  () => [props.spreadsheetId, props.recordId],
  () => {
    loadComments()
  },
  { immediate: true }
)
</script>

<style scoped>
.comments-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-left: 1px solid #e6e8eb;
  background: #fafafa;
  min-width: 260px;
}

.comments-panel__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.comments-panel__title {
  font-weight: 600;
}

.comments-panel__meta {
  font-size: 12px;
  color: #666;
}

.comments-panel__body {
  flex: 1;
  overflow: auto;
}

.comments-panel__status {
  font-size: 12px;
  color: #666;
}

.comments-panel__status--error {
  color: #d93025;
}

.comments-panel__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.comments-panel__item {
  padding: 8px;
  background: #fff;
  border: 1px solid #e6e8eb;
  border-radius: 6px;
}

.comments-panel__meta-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #888;
}

.comments-panel__form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.comments-panel__form textarea {
  resize: vertical;
  min-height: 64px;
  padding: 6px 8px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
}

.comments-panel__form button {
  align-self: flex-end;
  padding: 6px 12px;
  border-radius: 6px;
  border: none;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}

.comments-panel__form button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
