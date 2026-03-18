<template>
  <div v-if="visible" class="meta-comments-drawer">
    <div class="meta-comments-drawer__header">
      <h4 class="meta-comments-drawer__title">Comments</h4>
      <button class="meta-comments-drawer__close" @click="emit('close')">&times;</button>
    </div>
    <div class="meta-comments-drawer__body">
      <div v-if="loading" class="meta-comments-drawer__loading">Loading...</div>
      <div v-else-if="!comments.length" class="meta-comments-drawer__empty">No comments yet</div>
      <div v-for="c in comments" :key="c.id" class="meta-comments-drawer__item" :class="{ 'meta-comments-drawer__item--resolved': c.resolved }">
        <div class="meta-comments-drawer__meta">
          <span class="meta-comments-drawer__author">{{ c.authorName ?? c.authorId }}</span>
          <span class="meta-comments-drawer__time">{{ formatTime(c.createdAt) }}</span>
          <button
            v-if="canResolve && !c.resolved"
            class="meta-comments-drawer__resolve"
            :disabled="resolvingIds.includes(c.id)"
            @click="emit('resolve', c.id)"
          >{{ resolvingIds.includes(c.id) ? 'Resolving...' : 'Resolve' }}</button>
          <span v-if="c.resolved" class="meta-comments-drawer__badge">Resolved</span>
        </div>
        <p class="meta-comments-drawer__content">{{ c.content }}</p>
      </div>
    </div>
    <div v-if="canComment" class="meta-comments-drawer__input-area">
      <div v-if="error" class="meta-comments-drawer__error">{{ error }}</div>
      <div class="meta-comments-drawer__composer">
        <textarea
          :value="draft"
          class="meta-comments-drawer__textarea"
          placeholder="Add a comment..."
          rows="2"
          :disabled="submitting"
          @input="onDraftInput"
          @keydown.enter.ctrl="submitComment"
        />
        <button class="meta-comments-drawer__submit" :disabled="submitting || !draft.trim()" @click="submitComment">
          {{ submitting ? 'Sending...' : 'Send' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MultitableComment } from '../types'

const props = withDefaults(defineProps<{
  visible: boolean
  comments: MultitableComment[]
  loading: boolean
  canComment: boolean
  canResolve: boolean
  draft: string
  submitting?: boolean
  error?: string | null
  resolvingIds?: string[]
}>(), {
  draft: '',
  submitting: false,
  error: null,
  resolvingIds: () => [],
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submit', content: string): void
  (e: 'resolve', commentId: string): void
  (e: 'update:draft', value: string): void
}>()

function submitComment() {
  const text = props.draft.trim()
  if (!text || props.submitting) return
  emit('submit', text)
}

function onDraftInput(event: Event) {
  emit('update:draft', (event.target as HTMLTextAreaElement).value)
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}
</script>

<style scoped>
.meta-comments-drawer { width: 320px; border-left: 1px solid #e5e7eb; background: #fafbfc; display: flex; flex-direction: column; }
.meta-comments-drawer__header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid #eee; }
.meta-comments-drawer__title { font-size: 14px; font-weight: 600; margin: 0; }
.meta-comments-drawer__close { border: none; background: none; font-size: 18px; cursor: pointer; color: #999; }
.meta-comments-drawer__body { flex: 1; overflow-y: auto; padding: 10px 14px; }
.meta-comments-drawer__loading, .meta-comments-drawer__empty { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-comments-drawer__item { margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #f0f0f0; }
.meta-comments-drawer__item--resolved { opacity: 0.6; }
.meta-comments-drawer__meta { display: flex; gap: 8px; align-items: center; font-size: 11px; color: #999; margin-bottom: 4px; }
.meta-comments-drawer__author { font-weight: 500; color: #333; }
.meta-comments-drawer__resolve { border: none; background: none; color: #409eff; cursor: pointer; font-size: 11px; }
.meta-comments-drawer__resolve:disabled { opacity: 0.55; cursor: wait; }
.meta-comments-drawer__badge { color: #67c23a; font-size: 10px; }
.meta-comments-drawer__content { margin: 0; font-size: 13px; color: #333; line-height: 1.4; }
.meta-comments-drawer__input-area { padding: 10px 14px; border-top: 1px solid #eee; display: flex; flex-direction: column; gap: 8px; }
.meta-comments-drawer__composer { display: flex; gap: 8px; }
.meta-comments-drawer__error { margin-bottom: 8px; padding: 8px 10px; border-radius: 4px; background: #fef0f0; color: #f56c6c; font-size: 12px; }
.meta-comments-drawer__textarea { flex: 1; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; resize: none; }
.meta-comments-drawer__submit { padding: 6px 14px; background: #409eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.meta-comments-drawer__submit:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
