<!--
  W2 S4 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
  §7 S4, OD-W2-7=b in §6bis): DEPRECATED thin compat shell. The BODY (thread list + composer +
  reactions) now lives in MetaCommentsPanel.vue -- this file keeps ONLY its own header chrome
  (title / scope label / inbox RouterLink+badge / close button, unchanged byte-for-byte) and
  delegates the body to `<MetaCommentsPanel>`, forwarding every body-relevant prop/emit 1:1. It is
  kept (not retired) for the same reason MetaRecordDrawer.vue was kept at S3: both are still
  barrel-exported from `apps/web/src/multitable/index.ts` and there is no audited inventory of
  out-of-repo consumers (lock §6bis Medium-4 caveat) -- retiring it is a later, consumer-audited
  major cleanup, not this slice.

  `MultitableWorkbench.vue` no longer mounts this component at all (S4 diff) -- the workbench now
  passes comments state straight into `MetaRecordInspector`'s comments tab (which itself mounts
  `MetaCommentsPanel` directly, lock "收编 showComments 分支" / "右边缘只剩一个检查器"). This shell
  exists purely for barrel-export / external-consumer compat. Every existing `MetaCommentsDrawer`-
  mounting spec (`multitable-comments-drawer.spec.ts`, `meta-comments-drawer-migration.spec.ts`,
  `meta-comments-drawer-i18n.spec.ts`) is UNCHANGED and stays green -- it now exercises this shell's
  header + MetaCommentsPanel delegation for the body, which IS the compat contract this file
  promises.
-->
<template>
  <div v-if="visible" class="meta-comments-drawer">
    <div class="meta-comments-drawer__header">
      <div class="meta-comments-drawer__title-group">
        <h4 class="meta-comments-drawer__title">{{ l('comment.title') }}</h4>
        <div v-if="scopeLabel" class="meta-comments-drawer__scope">{{ scopeLabel }}</div>
      </div>
      <div class="meta-comments-drawer__header-actions">
        <RouterLink class="meta-comments-drawer__inbox-link" :to="{ name: 'multitable-comment-inbox' }">
          {{ l('comment.inbox') }}
          <span v-if="unreadCount > 0" class="meta-comments-drawer__inbox-badge">{{ unreadCount }}</span>
        </RouterLink>
        <MtIconButton class="meta-comments-drawer__close" @click="emit('close')">&times;</MtIconButton>
      </div>
    </div>
    <MetaCommentsPanel
      :comments="comments"
      :loading="loading"
      :can-comment="canComment"
      :can-resolve="canResolve"
      :draft="draft"
      :highlighted-comment-id="highlightedCommentId"
      :target-field-id="targetFieldId"
      :scope-label="scopeLabel"
      :reply-to-comment-id="replyToCommentId"
      :editing-comment-id="editingCommentId"
      :submitting="submitting"
      :error="error"
      :resolving-ids="resolvingIds"
      :updating-ids="updatingIds"
      :deleting-ids="deletingIds"
      :reacting-keys="reactingKeys"
      :current-user-id="currentUserId"
      :mention-suggestions="mentionSuggestions"
      :composer-initial-mentions="composerInitialMentions"
      :mention-candidates="mentionCandidates"
      @submit="(payload: { content: string; mentions: string[] }) => emit('submit', payload)"
      @resolve="(commentId: string) => emit('resolve', commentId)"
      @reply="(commentId: string) => emit('reply', commentId)"
      @edit="(commentId: string) => emit('edit', commentId)"
      @delete="(commentId: string) => emit('delete', commentId)"
      @cancel-reply="emit('cancel-reply')"
      @cancel-edit="emit('cancel-edit')"
      @update:draft="(value: string) => emit('update:draft', value)"
      @retry="emit('retry')"
      @react="(commentId: string, emoji: string) => emit('react', commentId, emoji)"
      @unreact="(commentId: string, emoji: string) => emit('unreact', commentId, emoji)"
    />
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useLocale } from '../../composables/useLocale'
import type { MetaCommentMentionSuggestion, MultitableComment } from '../types'
import { MtIconButton } from '../ui'
import { commentLabel, type MetaCommentLabelKey } from '../utils/meta-comment-labels'
import MetaCommentsPanel, { type MentionCandidateInput } from './MetaCommentsPanel.vue'

// W2 S4 (OD-W2-7=b): props/emits below are the drawer's PUBLIC compat contract, unchanged from
// pre-extraction — kept byte-identical so every existing MetaCommentsDrawer consumer (in-repo
// specs, any out-of-repo barrel-export consumer) needs zero changes. Header-only props (visible/
// scopeLabel/unreadCount) are consumed directly above; every other prop is forwarded 1:1 to
// MetaCommentsPanel.
withDefaults(defineProps<{
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
  reactingKeys?: string[]
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
  reactingKeys: () => [],
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
  (e: 'react', commentId: string, emoji: string): void
  (e: 'unreact', commentId: string, emoji: string): void
}>()

const { isZh } = useLocale()
const l = (key: MetaCommentLabelKey) => commentLabel(key, isZh.value)
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
/* .meta-comments-drawer__close: now <MtIconButton> (ghost, token-styled; the &times; glyph char passes
   through its default-slot icon fallback (size token-normalized to the icon control)). Bespoke hardcoded CSS
   removed (UI-P2-1c T1 batch-4). Class kept on the element only for selector stability. */
</style>
