<template>
  <div v-if="visible" class="meta-comments-drawer">
    <div class="meta-comments-drawer__header">
      <h4 class="meta-comments-drawer__title">Comments</h4>
      <div class="meta-comments-drawer__header-actions">
        <RouterLink class="meta-comments-drawer__inbox-link" :to="{ name: 'multitable-comment-inbox' }">
          Inbox
          <span v-if="unreadCount > 0" class="meta-comments-drawer__inbox-badge">{{ unreadCount }}</span>
        </RouterLink>
        <button class="meta-comments-drawer__close" @click="emit('close')">&times;</button>
      </div>
    </div>
    <div class="meta-comments-drawer__body">
      <div v-if="loading" class="meta-comments-drawer__loading">Loading...</div>
      <div v-else-if="!comments.length" class="meta-comments-drawer__empty">No comments yet</div>
      <div
        v-for="c in comments"
        :key="c.id"
        class="meta-comments-drawer__item"
        :class="{
          'meta-comments-drawer__item--resolved': c.resolved,
          'meta-comments-drawer__item--highlighted': highlightedCommentId === c.id,
        }"
      >
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
        <p class="meta-comments-drawer__content">{{ formatContent(c.content) }}</p>
      </div>
    </div>
    <div v-if="canComment" class="meta-comments-drawer__input-area">
      <div v-if="error" class="meta-comments-drawer__error">
        {{ error }}
        <button class="meta-comments-drawer__retry" @click="emit('retry')">Retry</button>
      </div>
      <MetaCommentComposer
        v-model="draftModel"
        :suggestions="mentionSuggestions"
        :disabled="!canComment"
        :submitting="submitting"
        placeholder="Add a comment..."
        @submit="submitComment"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { MetaCommentMentionSuggestion, MultitableComment } from '../types'
import MetaCommentComposer from './MetaCommentComposer.vue'

const props = withDefaults(defineProps<{
  visible: boolean
  comments: MultitableComment[]
  loading: boolean
  canComment: boolean
  canResolve: boolean
  draft: string
  highlightedCommentId?: string | null
  unreadCount?: number
  submitting?: boolean
  error?: string | null
  resolvingIds?: string[]
  mentionSuggestions?: MetaCommentMentionSuggestion[]
}>(), {
  draft: '',
  highlightedCommentId: null,
  unreadCount: 0,
  submitting: false,
  error: null,
  resolvingIds: () => [],
  mentionSuggestions: () => [],
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submit', payload: { content: string; mentions: string[] }): void
  (e: 'resolve', commentId: string): void
  (e: 'update:draft', value: string): void
  (e: 'retry'): void
}>()

const draftModel = computed({
  get: () => props.draft,
  set: (value: string) => emit('update:draft', value),
})

const defaultMentionSuggestions = computed<MetaCommentMentionSuggestion[]>(() => {
  const seen = new Set<string>()
  return props.comments
    .map((comment) => ({
      id: comment.authorId.trim(),
      label: (comment.authorName ?? comment.authorId).trim() || comment.authorId,
      subtitle: comment.authorName && comment.authorName !== comment.authorId ? comment.authorId : undefined,
    }))
    .filter((item) => {
      if (!item.id) return false
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .slice(0, 8)
})

const mentionSuggestions = computed(() => props.mentionSuggestions.length ? props.mentionSuggestions : defaultMentionSuggestions.value)

function submitComment(payload: { content: string; mentions: string[] }) {
  if (!payload.content.trim() || props.submitting) return
  emit('submit', payload)
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function formatContent(content: string): string {
  return content.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_match, label) => `@${label}`)
}
</script>

<style scoped>
.meta-comments-drawer { width: 320px; border-left: 1px solid #e5e7eb; background: #fafbfc; display: flex; flex-direction: column; }
.meta-comments-drawer__header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid #eee; }
.meta-comments-drawer__header-actions { display: flex; align-items: center; gap: 8px; }
.meta-comments-drawer__title { font-size: 14px; font-weight: 600; margin: 0; }
.meta-comments-drawer__inbox-link { color: #409eff; font-size: 12px; text-decoration: none; }
.meta-comments-drawer__inbox-link:hover { text-decoration: underline; }
.meta-comments-drawer__inbox-badge { margin-left: 6px; padding: 2px 6px; border-radius: 999px; background: #eff6ff; color: #2563eb; font-size: 11px; }
.meta-comments-drawer__close { border: none; background: none; font-size: 18px; cursor: pointer; color: #999; }
.meta-comments-drawer__body { flex: 1; overflow-y: auto; padding: 10px 14px; }
.meta-comments-drawer__loading, .meta-comments-drawer__empty { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-comments-drawer__item { margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #f0f0f0; }
.meta-comments-drawer__item--resolved { opacity: 0.6; }
.meta-comments-drawer__item--highlighted { background: #eff6ff; border-radius: 8px; padding: 8px; }
.meta-comments-drawer__meta { display: flex; gap: 8px; align-items: center; font-size: 11px; color: #999; margin-bottom: 4px; }
.meta-comments-drawer__author { font-weight: 500; color: #333; }
.meta-comments-drawer__resolve { border: none; background: none; color: #409eff; cursor: pointer; font-size: 11px; }
.meta-comments-drawer__resolve:disabled { opacity: 0.55; cursor: wait; }
.meta-comments-drawer__badge { color: #67c23a; font-size: 10px; }
.meta-comments-drawer__content { margin: 0; font-size: 13px; color: #333; line-height: 1.4; }
.meta-comments-drawer__input-area { padding: 10px 14px; border-top: 1px solid #eee; display: flex; flex-direction: column; gap: 8px; }
.meta-comments-drawer__error { margin-bottom: 8px; padding: 8px 10px; border-radius: 4px; background: #fef0f0; color: #f56c6c; font-size: 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.meta-comments-drawer__retry { border: 1px solid #f56c6c; background: #fff; color: #f56c6c; padding: 2px 8px; border-radius: 3px; font-size: 11px; cursor: pointer; white-space: nowrap; }
.meta-comments-drawer__retry:hover { background: #fef0f0; }
</style>
