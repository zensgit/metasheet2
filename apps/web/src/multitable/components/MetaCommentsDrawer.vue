<template>
  <div v-if="visible" class="meta-comments-drawer">
    <div class="meta-comments-drawer__header">
      <div class="meta-comments-drawer__title-group">
        <h4 class="meta-comments-drawer__title">Comments</h4>
        <div v-if="scopeLabel" class="meta-comments-drawer__scope">{{ scopeLabel }}</div>
      </div>
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
      <div v-else-if="!threadRoots.length" class="meta-comments-drawer__empty">{{ emptyMessage }}</div>
      <div v-for="thread in threadRoots" :key="thread.id" class="meta-comments-drawer__thread">
        <div
          class="meta-comments-drawer__item"
          :class="{
            'meta-comments-drawer__item--resolved': thread.resolved,
            'meta-comments-drawer__item--highlighted': highlightedCommentId === thread.id,
          }"
        >
          <div class="meta-comments-drawer__meta">
            <span class="meta-comments-drawer__author">{{ thread.authorName ?? thread.authorId }}</span>
            <span class="meta-comments-drawer__time">{{ formatTime(thread.createdAt) }}</span>
            <span
              v-if="getReplyCount(thread.id) > 0"
              class="meta-comments-drawer__thread-count"
            >{{ formatReplyCount(getReplyCount(thread.id)) }}</span>
            <button
              v-if="canComment && !thread.resolved"
              class="meta-comments-drawer__reply"
              @click="emit('reply', thread.id)"
            >Reply</button>
            <button
              v-if="canEditComment(thread)"
              class="meta-comments-drawer__reply"
              :disabled="updatingIds.includes(thread.id) || deletingIds.includes(thread.id)"
              @click="emit('edit', thread.id)"
            >{{ editingCommentId === thread.id ? 'Editing...' : 'Edit' }}</button>
            <button
              v-if="canDeleteComment(thread)"
              class="meta-comments-drawer__reply"
              :disabled="deletingIds.includes(thread.id) || updatingIds.includes(thread.id)"
              @click="emit('delete', thread.id)"
            >{{ deletingIds.includes(thread.id) ? 'Deleting...' : 'Delete' }}</button>
            <button
              v-if="canResolve && !thread.resolved"
              class="meta-comments-drawer__resolve"
              :disabled="resolvingIds.includes(thread.id)"
              @click="emit('resolve', thread.id)"
            >{{ resolvingIds.includes(thread.id) ? 'Resolving...' : 'Resolve' }}</button>
            <span v-if="thread.resolved" class="meta-comments-drawer__badge">Resolved</span>
          </div>
          <p class="meta-comments-drawer__content">{{ formatContent(thread.content) }}</p>
        </div>
        <div
          v-for="reply in repliesByParentId[thread.id] ?? []"
          :key="reply.id"
          class="meta-comments-drawer__reply-item"
          :class="{
            'meta-comments-drawer__item--resolved': reply.resolved,
            'meta-comments-drawer__item--highlighted': highlightedCommentId === reply.id,
          }"
        >
          <div class="meta-comments-drawer__meta">
            <span class="meta-comments-drawer__author">{{ reply.authorName ?? reply.authorId }}</span>
            <span class="meta-comments-drawer__time">{{ formatTime(reply.createdAt) }}</span>
            <button
              v-if="canEditComment(reply)"
              class="meta-comments-drawer__reply"
              :disabled="updatingIds.includes(reply.id) || deletingIds.includes(reply.id)"
              @click="emit('edit', reply.id)"
            >{{ editingCommentId === reply.id ? 'Editing...' : 'Edit' }}</button>
            <button
              v-if="canDeleteComment(reply)"
              class="meta-comments-drawer__reply"
              :disabled="deletingIds.includes(reply.id) || updatingIds.includes(reply.id)"
              @click="emit('delete', reply.id)"
            >{{ deletingIds.includes(reply.id) ? 'Deleting...' : 'Delete' }}</button>
          </div>
          <p class="meta-comments-drawer__content">{{ formatContent(reply.content) }}</p>
        </div>
      </div>
    </div>
    <div v-if="canComment" class="meta-comments-drawer__input-area">
      <div v-if="error" class="meta-comments-drawer__error">
        {{ error }}
        <button class="meta-comments-drawer__retry" @click="emit('retry')">Retry</button>
      </div>
      <div v-if="activeEditingComment" class="meta-comments-drawer__reply-banner">
        <div class="meta-comments-drawer__reply-banner-copy">
          <span>Editing {{ activeEditingComment.authorName ?? activeEditingComment.authorId }}</span>
          <span class="meta-comments-drawer__reply-preview">{{ formatCommentPreview(activeEditingComment.content) }}</span>
        </div>
        <button class="meta-comments-drawer__reply-cancel" @click="emit('cancel-edit')">Cancel</button>
      </div>
      <div v-else-if="activeReplyComment" class="meta-comments-drawer__reply-banner">
        <div class="meta-comments-drawer__reply-banner-copy">
          <span>Replying to {{ activeReplyComment.authorName ?? activeReplyComment.authorId }}</span>
          <span class="meta-comments-drawer__reply-preview">{{ formatCommentPreview(activeReplyComment.content) }}</span>
        </div>
        <button class="meta-comments-drawer__reply-cancel" @click="emit('cancel-reply')">Cancel</button>
      </div>
      <MetaCommentComposer
        v-model="draftModel"
        :suggestions="mentionSuggestions"
        :initial-mentions="composerInitialMentions"
        :disabled="!canComment"
        :submitting="submitting"
        :placeholder="activeEditingComment ? 'Edit comment…' : activeReplyComment ? 'Reply to thread…' : 'Add a comment...'"
        :submit-label="activeEditingComment ? 'Save' : 'Send'"
        @submit="submitComment"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { MetaCommentMentionSuggestion, MultitableComment } from '../types'
import { normalizeMultitableComment } from '../api/client'
import MetaCommentComposer from './MetaCommentComposer.vue'

export type MentionCandidateInput = {
  userId: string
  displayName: string
  secondaryLabel?: string | null
}

const props = withDefaults(defineProps<{
  visible: boolean
  comments: MultitableComment[]
  loading: boolean
  canComment: boolean
  canResolve: boolean
  draft: string
  highlightedCommentId?: string | null
  targetFieldId?: string | null
  scopeLabel?: string | null
  replyToCommentId?: string | null
  editingCommentId?: string | null
  unreadCount?: number
  submitting?: boolean
  error?: string | null
  resolvingIds?: string[]
  updatingIds?: string[]
  deletingIds?: string[]
  currentUserId?: string | null
  mentionSuggestions?: MetaCommentMentionSuggestion[]
  composerInitialMentions?: MetaCommentMentionSuggestion[]
  mentionCandidates?: MentionCandidateInput[]
}>(), {
  draft: '',
  highlightedCommentId: null,
  targetFieldId: null,
  scopeLabel: null,
  replyToCommentId: null,
  editingCommentId: null,
  unreadCount: 0,
  submitting: false,
  error: null,
  resolvingIds: () => [],
  updatingIds: () => [],
  deletingIds: () => [],
  currentUserId: null,
  mentionSuggestions: () => [],
  composerInitialMentions: () => [],
  mentionCandidates: () => [],
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submit', payload: { content: string; mentions: string[] }): void
  (e: 'resolve', commentId: string): void
  (e: 'reply', commentId: string): void
  (e: 'edit', commentId: string): void
  (e: 'delete', commentId: string): void
  (e: 'cancel-reply'): void
  (e: 'cancel-edit'): void
  (e: 'update:draft', value: string): void
  (e: 'retry'): void
}>()

const draftModel = computed({
  get: () => props.draft,
  set: (value: string) => emit('update:draft', value),
})

const normalizedComments = computed(() => props.comments.map((comment) => normalizeMultitableComment(comment)))

const visibleComments = computed(() => {
  if (!props.targetFieldId) return normalizedComments.value

  const commentsById = new Map(normalizedComments.value.map((comment) => [comment.id, comment]))
  const childIdsByParent = new Map<string, string[]>()
  for (const comment of normalizedComments.value) {
    if (!comment.parentId) continue
    const siblings = childIdsByParent.get(comment.parentId) ?? []
    siblings.push(comment.id)
    childIdsByParent.set(comment.parentId, siblings)
  }

  const visibleIds = new Set<string>()
  const queue: string[] = []
  for (const comment of normalizedComments.value) {
    const fieldId = comment.fieldId ?? null
    if (fieldId !== props.targetFieldId || visibleIds.has(comment.id)) continue
    visibleIds.add(comment.id)
    queue.push(comment.id)
  }

  while (queue.length) {
    const commentId = queue.shift()!
    const comment = commentsById.get(commentId)
    if (!comment) continue

    if (comment.parentId && commentsById.has(comment.parentId) && !visibleIds.has(comment.parentId)) {
      visibleIds.add(comment.parentId)
      queue.push(comment.parentId)
    }

    for (const childId of childIdsByParent.get(commentId) ?? []) {
      if (visibleIds.has(childId)) continue
      visibleIds.add(childId)
      queue.push(childId)
    }
  }

  return normalizedComments.value.filter((comment) => {
    return visibleIds.has(comment.id)
  })
})

const commentIds = computed(() => new Set(visibleComments.value.map((comment) => comment.id)))

const repliesByParentId = computed<Record<string, MultitableComment[]>>(() => {
  const map: Record<string, MultitableComment[]> = {}
  for (const comment of visibleComments.value) {
    if (!comment.parentId) continue
    if (!commentIds.value.has(comment.parentId)) continue
    if (!map[comment.parentId]) map[comment.parentId] = []
    map[comment.parentId].push(comment)
  }
  return map
})

const threadRoots = computed(() => visibleComments.value.filter((comment) => {
  if (!comment.parentId) return true
  return !commentIds.value.has(comment.parentId)
}))

const activeReplyComment = computed(() => {
  const replyId = props.replyToCommentId
  if (!replyId) return null
  return visibleComments.value.find((comment) => comment.id === replyId) ?? null
})

const activeEditingComment = computed(() => {
  const editId = props.editingCommentId
  if (!editId) return null
  return visibleComments.value.find((comment) => comment.id === editId) ?? null
})

const emptyMessage = computed(() => {
  if (props.targetFieldId && props.scopeLabel) return `No comments yet for ${props.scopeLabel}`
  if (props.targetFieldId) return 'No comments yet for this field'
  return 'No comments yet'
})

const defaultMentionSuggestions = computed<MetaCommentMentionSuggestion[]>(() => {
  const seen = new Set<string>()
  const fromCandidates = (props.mentionCandidates ?? [])
    .filter((candidate) => typeof candidate.userId === 'string' && candidate.userId.trim().length > 0)
    .map((candidate) => ({
      id: candidate.userId.trim(),
      label: candidate.displayName?.trim() || candidate.userId.trim(),
      subtitle: candidate.secondaryLabel?.trim() || undefined,
    }))
  const fromAuthors = normalizedComments.value
    .map((comment) => ({
      id: comment.authorId.trim(),
      label: (comment.authorName ?? comment.authorId).trim() || comment.authorId,
      subtitle: comment.authorName && comment.authorName !== comment.authorId ? comment.authorId : undefined,
    }))

  return [...fromCandidates, ...fromAuthors]
    .filter((item) => {
      if (!item.id) return false
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .slice(0, 8)
})

const mentionSuggestions = computed(() => {
  const seen = new Set<string>()
  return [...props.mentionSuggestions, ...defaultMentionSuggestions.value]
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .slice(0, 12)
})

function submitComment(payload: { content: string; mentions: string[] }) {
  if (!payload.content.trim() || props.submitting) return
  emit('submit', payload)
}

function isOwnComment(comment: MultitableComment): boolean {
  return Boolean(props.currentUserId && comment.authorId === props.currentUserId)
}

function canEditComment(comment: MultitableComment): boolean {
  return props.canComment && isOwnComment(comment) && !comment.resolved
}

function canDeleteComment(comment: MultitableComment): boolean {
  if (!props.canComment || !isOwnComment(comment)) return false
  return !(repliesByParentId.value[comment.id]?.length)
}

function getReplyCount(commentId: string): number {
  return repliesByParentId.value[commentId]?.length ?? 0
}

function formatReplyCount(count: number): string {
  return count === 1 ? '1 reply' : `${count} replies`
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function formatContent(content: string): string {
  return content.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_match, label) => `@${label}`)
}

function formatCommentPreview(content: string): string {
  const normalized = formatContent(content).replace(/\s+/g, ' ').trim()
  if (normalized.length <= 72) return normalized
  return `${normalized.slice(0, 69).trimEnd()}...`
}
</script>

<style scoped>
.meta-comments-drawer { width: 320px; border-left: 1px solid #e5e7eb; background: #fafbfc; display: flex; flex-direction: column; }
.meta-comments-drawer__header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid #eee; }
.meta-comments-drawer__title-group { display: flex; flex-direction: column; gap: 2px; }
.meta-comments-drawer__header-actions { display: flex; align-items: center; gap: 8px; }
.meta-comments-drawer__title { font-size: 14px; font-weight: 600; margin: 0; }
.meta-comments-drawer__scope { color: #6b7280; font-size: 11px; }
.meta-comments-drawer__inbox-link { color: #409eff; font-size: 12px; text-decoration: none; }
.meta-comments-drawer__inbox-link:hover { text-decoration: underline; }
.meta-comments-drawer__inbox-badge { margin-left: 6px; padding: 2px 6px; border-radius: 999px; background: #eff6ff; color: #2563eb; font-size: 11px; }
.meta-comments-drawer__close { border: none; background: none; font-size: 18px; cursor: pointer; color: #999; }
.meta-comments-drawer__body { flex: 1; overflow-y: auto; padding: 10px 14px; }
.meta-comments-drawer__loading, .meta-comments-drawer__empty { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-comments-drawer__thread { margin-bottom: 12px; }
.meta-comments-drawer__item { padding-bottom: 10px; border-bottom: 1px solid #f0f0f0; }
.meta-comments-drawer__reply-item { margin: 8px 0 0 18px; padding-left: 10px; border-left: 2px solid #e5e7eb; }
.meta-comments-drawer__item--resolved { opacity: 0.6; }
.meta-comments-drawer__item--highlighted { background: #eff6ff; border-radius: 8px; padding: 8px; }
.meta-comments-drawer__meta { display: flex; gap: 8px; align-items: center; font-size: 11px; color: #999; margin-bottom: 4px; }
.meta-comments-drawer__author { font-weight: 500; color: #333; }
.meta-comments-drawer__reply { border: none; background: none; color: #2563eb; cursor: pointer; font-size: 11px; }
.meta-comments-drawer__resolve { border: none; background: none; color: #409eff; cursor: pointer; font-size: 11px; }
.meta-comments-drawer__resolve:disabled { opacity: 0.55; cursor: wait; }
.meta-comments-drawer__badge { color: #67c23a; font-size: 10px; }
.meta-comments-drawer__thread-count { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 999px; background: #eef2ff; color: #4338ca; font-size: 10px; font-weight: 600; }
.meta-comments-drawer__content { margin: 0; font-size: 13px; color: #333; line-height: 1.4; }
.meta-comments-drawer__input-area { padding: 10px 14px; border-top: 1px solid #eee; display: flex; flex-direction: column; gap: 8px; }
.meta-comments-drawer__reply-banner { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; background: #eff6ff; color: #1d4ed8; font-size: 12px; }
.meta-comments-drawer__reply-banner-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.meta-comments-drawer__reply-preview { color: #1e3a8a; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta-comments-drawer__reply-cancel { border: none; background: none; color: #1d4ed8; cursor: pointer; font-size: 11px; }
.meta-comments-drawer__error { margin-bottom: 8px; padding: 8px 10px; border-radius: 4px; background: #fef0f0; color: #f56c6c; font-size: 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.meta-comments-drawer__retry { border: 1px solid #f56c6c; background: #fff; color: #f56c6c; padding: 2px 8px; border-radius: 3px; font-size: 11px; cursor: pointer; white-space: nowrap; }
.meta-comments-drawer__retry:hover { background: #fef0f0; }
</style>
