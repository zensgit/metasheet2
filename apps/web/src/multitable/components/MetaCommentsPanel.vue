<!--
  W2 S4 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
  §2 组件表 "评论面板" row, §7 S4): behavior-equivalent extraction of MetaCommentsDrawer.vue's BODY —
  thread list (§ `.meta-comments-drawer__body`) + composer/input-area (§ `.meta-comments-drawer__
  input-area`), reactions, presence-driven affordance — moved VERBATIM (same class names, same
  computed logic, same emit names/payload shapes). This component does NOT own the drawer's own
  `__header` chrome (title / scope label / inbox RouterLink / close button) — that stays with
  MetaCommentsDrawer.vue (now a deprecated thin shell, lock OD-W2-7=b) and is separately duplicated
  into MetaRecordInspector.vue's OWN header (the inbox link "上移到检查器头部" per lock §2 table).

  HI-1 (zero new data paths): this panel makes NO fetches of its own. Every value it renders comes
  from props the pre-extraction drawer already received (comments/loading/canComment/canResolve/etc,
  ultimately `commentsState.*` + `selectedRecordCommentsScope` — both already server G-8 gated,
  lock §5 table). No new network-call surface (fetch, the api client, etc.) is introduced here.

  Emits mirror the pre-extraction drawer's emit set 1:1 (submit/resolve/reply/edit/delete/
  cancel-reply/cancel-edit/update:draft/retry/react/unreact) — MINUS `close`, which this panel does
  not have (no chrome of its own to close; the inspector shell's own close button is the only close
  affordance now, lock §2 "不含它自己的 __header 抽屉外壳与 close 钮"). MetaRecordInspector.vue
  re-emits each of these upward with a `comment-` prefix (its own pre-existing `delete`/`close`
  emits already mean something else — record-delete / inspector-close — so the prefix avoids a
  silent payload collision at that boundary; this file's own emit names are unprefixed and
  unchanged from the drawer, since there is no such collision here).

  Class names are kept byte-identical to the pre-extraction drawer's body markup (`meta-comments-
  drawer__*`, not renamed to a new `meta-comments-panel__*` prefix) — this is what keeps the frozen
  `multitable-comments-drawer.spec.ts` / `meta-comments-drawer-migration.spec.ts` /
  `meta-comments-drawer-i18n.spec.ts` specs passing UNMODIFIED against the thin-shell delegation,
  the same "byte-identical extraction" discipline S1 used for MetaRecordFieldsPanel.vue (which kept
  the `meta-record-drawer__*` prefix rather than renaming to `meta-record-fields-panel__*`). The one
  NEW class, `.meta-comments-drawer__panel`, is this component's own mount root (the pre-extraction
  drawer had no single wrapper around body+input-area — they were direct siblings of the header
  under `.meta-comments-drawer`'s own flex column) — same "add one root class, keep everything
  inside it verbatim" move S1/S2 made for `.meta-record-drawer__fields` / `.meta-record-drawer__
  history`.

  Known cosmetic difference (not a correctness regression, deferred to §8.3 real-browser sweep,
  same honesty-clause precedent as S3's un-verified focus-ring note): the pre-extraction drawer's
  scrolling thread-list + pinned-bottom composer relied on being a bounded-height flex child of a
  fixed-width standalone drawer. Mounted inside MetaRecordInspector's tabpanel (a plain block, part
  of the whole-inspector single scroll region, per lock §3.1 "push" layout), there is no ambient
  height bound for `.meta-comments-drawer__panel`'s `flex: 1` to flex against, so the thread list
  will grow with the page instead of scrolling internally. The CSS chain itself (`.meta-comments-
  drawer__panel { display:flex; flex-direction:column }` → `__body{flex:1;overflow-y:auto}` +
  `__input-area` natural height) is preserved unchanged so the OLD standalone-drawer mount (still
  used by the deprecated MetaCommentsDrawer.vue shell) keeps its original scrolling behavior
  byte-for-byte.
-->
<template>
  <div class="meta-comments-drawer__panel">
    <div class="meta-comments-drawer__body">
      <div v-if="loading" class="meta-comments-drawer__loading">{{ l('comment.loading') }}</div>
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
            >{{ l('comment.reply') }}</button>
            <button
              v-if="canEditComment(thread)"
              class="meta-comments-drawer__reply"
              :disabled="updatingIds.includes(thread.id) || deletingIds.includes(thread.id)"
              @click="emit('edit', thread.id)"
            >{{ editingCommentId === thread.id ? l('comment.editing') : l('comment.edit') }}</button>
            <button
              v-if="canDeleteComment(thread)"
              class="meta-comments-drawer__reply"
              :disabled="deletingIds.includes(thread.id) || updatingIds.includes(thread.id)"
              @click="emit('delete', thread.id)"
            >{{ deletingIds.includes(thread.id) ? l('comment.deleting') : l('comment.delete') }}</button>
            <button
              v-if="canResolve && !thread.resolved"
              class="meta-comments-drawer__resolve"
              :disabled="resolvingIds.includes(thread.id)"
              @click="emit('resolve', thread.id)"
            >{{ resolvingIds.includes(thread.id) ? l('comment.resolving') : l('comment.resolve') }}</button>
            <span v-if="thread.resolved" class="meta-comments-drawer__badge">{{ l('comment.resolved') }}</span>
          </div>
          <p class="meta-comments-drawer__content">{{ formatContent(thread.content) }}</p>
          <MetaCommentReactions
            v-if="canComment || (thread.reactions && thread.reactions.length > 0)"
            :comment-id="thread.id"
            :reactions="thread.reactions"
            :can-react="canComment"
            :pending-keys="reactingKeys"
            :add-label="l('comment.addReaction')"
            @react="(id, emoji) => emit('react', id, emoji)"
            @unreact="(id, emoji) => emit('unreact', id, emoji)"
          />
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
            >{{ editingCommentId === reply.id ? l('comment.editing') : l('comment.edit') }}</button>
            <button
              v-if="canDeleteComment(reply)"
              class="meta-comments-drawer__reply"
              :disabled="deletingIds.includes(reply.id) || updatingIds.includes(reply.id)"
              @click="emit('delete', reply.id)"
            >{{ deletingIds.includes(reply.id) ? l('comment.deleting') : l('comment.delete') }}</button>
          </div>
          <p class="meta-comments-drawer__content">{{ formatContent(reply.content) }}</p>
          <MetaCommentReactions
            v-if="canComment || (reply.reactions && reply.reactions.length > 0)"
            :comment-id="reply.id"
            :reactions="reply.reactions"
            :can-react="canComment"
            :pending-keys="reactingKeys"
            :add-label="l('comment.addReaction')"
            @react="(id, emoji) => emit('react', id, emoji)"
            @unreact="(id, emoji) => emit('unreact', id, emoji)"
          />
        </div>
      </div>
    </div>
    <div v-if="canComment" class="meta-comments-drawer__input-area">
      <div v-if="error" class="meta-comments-drawer__error">
        {{ error }}
        <button class="meta-comments-drawer__retry" @click="emit('retry')">{{ l('comment.retry') }}</button>
      </div>
      <div v-if="activeEditingComment" class="meta-comments-drawer__reply-banner">
        <div class="meta-comments-drawer__reply-banner-copy">
          <span>{{ activeEditingBanner }}</span>
          <span class="meta-comments-drawer__reply-preview">{{ formatCommentPreview(activeEditingComment.content) }}</span>
        </div>
        <button class="meta-comments-drawer__reply-cancel" @click="emit('cancel-edit')">{{ l('comment.cancel') }}</button>
      </div>
      <div v-else-if="activeReplyComment" class="meta-comments-drawer__reply-banner">
        <div class="meta-comments-drawer__reply-banner-copy">
          <span>{{ activeReplyBanner }}</span>
          <span class="meta-comments-drawer__reply-preview">{{ formatCommentPreview(activeReplyComment.content) }}</span>
        </div>
        <button class="meta-comments-drawer__reply-cancel" @click="emit('cancel-reply')">{{ l('comment.cancel') }}</button>
      </div>
      <MetaCommentComposer
        v-model="draftModel"
        :suggestions="mentionSuggestions"
        :initial-mentions="composerInitialMentions"
        :disabled="!canComment"
        :submitting="submitting"
        :placeholder="composerPlaceholder"
        :submit-label="composerSubmitLabel"
        :submit-kind="composerSubmitKind"
        @submit="submitComment"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MetaCommentMentionSuggestion, MultitableComment } from '../types'
import { normalizeMultitableComment } from '../api/client'
import {
  commentLabel,
  editingBanner,
  emptyMessage as commentEmptyMessage,
  replyingBanner,
  replyCount,
  type MetaCommentLabelKey,
} from '../utils/meta-comment-labels'
import MetaCommentComposer from './MetaCommentComposer.vue'
import MetaCommentReactions from './MetaCommentReactions.vue'

export type MentionCandidateInput = {
  userId: string
  displayName: string
  secondaryLabel?: string | null
}

const props = withDefaults(defineProps<{
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
  submitting?: boolean
  error?: string | null
  resolvingIds?: string[]
  updatingIds?: string[]
  deletingIds?: string[]
  reactingKeys?: string[]
  currentUserId?: string | null
  mentionSuggestions?: MetaCommentMentionSuggestion[]
  composerInitialMentions?: MetaCommentMentionSuggestion[]
  mentionCandidates?: MentionCandidateInput[]
}>(), {
  highlightedCommentId: null,
  targetFieldId: null,
  scopeLabel: null,
  replyToCommentId: null,
  editingCommentId: null,
  submitting: false,
  error: null,
  resolvingIds: () => [],
  updatingIds: () => [],
  deletingIds: () => [],
  reactingKeys: () => [],
  currentUserId: null,
  mentionSuggestions: () => [],
  composerInitialMentions: () => [],
  mentionCandidates: () => [],
})

const emit = defineEmits<{
  (e: 'submit', payload: { content: string; mentions: string[] }): void
  (e: 'resolve', commentId: string): void
  (e: 'reply', commentId: string): void
  (e: 'edit', commentId: string): void
  (e: 'delete', commentId: string): void
  (e: 'cancel-reply'): void
  (e: 'cancel-edit'): void
  (e: 'update:draft', value: string): void
  (e: 'retry'): void
  (e: 'react', commentId: string, emoji: string): void
  (e: 'unreact', commentId: string, emoji: string): void
}>()

const draftModel = computed({
  get: () => props.draft,
  set: (value: string) => emit('update:draft', value),
})

const { isZh } = useLocale()
const l = (key: MetaCommentLabelKey) => commentLabel(key, isZh.value)
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
  return commentEmptyMessage(props.scopeLabel, props.targetFieldId, isZh.value)
})

const activeEditingBanner = computed(() => {
  if (!activeEditingComment.value) return ''
  return editingBanner(activeEditingComment.value.authorName ?? activeEditingComment.value.authorId, isZh.value)
})

const activeReplyBanner = computed(() => {
  if (!activeReplyComment.value) return ''
  return replyingBanner(activeReplyComment.value.authorName ?? activeReplyComment.value.authorId, isZh.value)
})

const composerSubmitKind = computed<'send' | 'save'>(() => (activeEditingComment.value ? 'save' : 'send'))
const composerSubmitLabel = computed(() => (
  composerSubmitKind.value === 'save' ? l('comment.submitSave') : l('comment.submitSend')
))
const composerPlaceholder = computed(() => {
  if (activeEditingComment.value) return l('comment.placeholderEdit')
  if (activeReplyComment.value) return l('comment.placeholderReply')
  return l('comment.placeholderAdd')
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
  return [...(props.mentionSuggestions ?? []), ...defaultMentionSuggestions.value]
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
  return replyCount(count, isZh.value)
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
.meta-comments-drawer__panel { display: flex; flex-direction: column; flex: 1; min-height: 0; }
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
