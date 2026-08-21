<!--
  S3b (approval comments tab): the thin approval-side wrapper around the S3a shared comments kit
  (`shared/comments/components/MetaCommentsPanel.vue` + `useMultitableComments`), mounted from
  ApprovalDetailView.vue's 全文评论 tab. Owns:
    - the `useMultitableComments(approvalCommentsClient)` composable instance (list/create/edit/
      delete + their loading/error state)
    - draft / reply-target / edit-target local UI state
    - the member-display-identity guard (resolved name, or a values-free `成员 N` ordinal — NEVER
      the raw author/mention id — per approval-member-identity-coverage-enumeration.spec.ts's
      "GATE FOR THE NEXT SLICE" disposition)
    - the mention-candidate roster fetch (once per instance, no per-keystroke network — the
      composer filters client-side)

  Capability gating: `:can-resolve="false"` and `:enable-reactions="false"` — S2 exposes neither
  endpoint. The adapter's `resolveComment`/`addReaction`/`removeReaction` additionally THROW
  `ApprovalCommentsUnsupportedOperationError` (approvalCommentsClient.ts) so a regression that
  re-enabled either UI gate would fail closed at the transport layer too, not silently no-op.

  Deletion: this wrapper calls `comments.deleteComment(id)` (keeps the composable's own
  `deletingIds`/error bookkeeping) then re-lists (`comments.loadComments`) to hydrate the
  tombstone the composable's own `applyDeletedComment` would otherwise locally strip — see the
  wiring contract §4 "Delete flow — approach (a)".

  Threading: S2 is exactly one level; a reply-to-a-tombstone is ALLOWED (201) — this wrapper does
  not add a client-side block on that, matching the backend.

  HI-1 is NOT a constraint on this file (only on the shared kit's own MetaCommentsPanel.vue) — this
  wrapper is exactly where the fetch/client calls are SUPPOSED to live.
-->
<template>
  <div class="approval-comments-panel" data-testid="approval-comments-panel">
    <div v-if="truncatedNotice" class="approval-comments-panel__truncated" data-testid="approval-comments-truncated-notice">
      {{ truncatedNotice }}
    </div>
    <MetaCommentsPanel
      :comments="commentsForPanel"
      :loading="comments.loading.value"
      :can-comment="true"
      :can-resolve="false"
      :enable-reactions="false"
      :target-field-id="null"
      :draft="draft"
      :reply-to-comment-id="replyToCommentId"
      :editing-comment-id="editingCommentId"
      :submitting="comments.submitting.value"
      :error="comments.error.value"
      :resolving-ids="comments.resolvingIds.value"
      :updating-ids="comments.updatingIds.value"
      :deleting-ids="comments.deletingIds.value"
      :current-user-id="currentUserId"
      :mention-candidates="mentionCandidatesForPanel"
      :composer-initial-mentions="composerInitialMentions"
      @submit="handleSubmit"
      @reply="handleReplyStart"
      @edit="handleEditStart"
      @delete="handleDelete"
      @cancel-reply="handleCancel"
      @cancel-edit="handleCancel"
      @update:draft="(value: string) => (draft = value)"
      @retry="handleRetry"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import MetaCommentsPanel, { type MentionCandidateInput } from '../../shared/comments/components/MetaCommentsPanel.vue'
import { useMultitableComments } from '../../shared/comments/composables/useMultitableComments'
import type { MetaCommentMentionSuggestion } from '../../shared/comments/types'
import {
  createApprovalCommentsClient,
  fetchApprovalCommentMentionCandidates,
  type ApprovalCommentMentionCandidate,
} from '../../approvals/approvalCommentsClient'
import { ensureUserNamesResolved, getResolvedUserName } from '../../approvals/directoryResolve'

const props = defineProps<{
  instanceId: string
  currentUserId?: string | null
}>()

// One client per mount, instanceId read live via closure on every call — see
// approvalCommentsClient.ts's own header note on why this is the ONE source of truth (never
// `params.containerId`) across a route-param-only navigation.
const client = createApprovalCommentsClient(() => props.instanceId)
const comments = useMultitableComments(client)

const draft = ref('')
const replyToCommentId = ref<string | null>(null)
const editingCommentId = ref<string | null>(null)
const composerInitialMentions = ref<MetaCommentMentionSuggestion[]>([])
const mentionCandidates = ref<ApprovalCommentMentionCandidate[]>([])

const scopeTarget = computed(() => ({
  containerId: props.instanceId,
  targetId: props.instanceId,
  targetFieldId: null as string | null,
}))

const truncatedNotice = computed(() => (
  client.truncated.value
    ? '仅显示最近的评论——历史评论过多，未全部加载。'
    : ''
))

// -----------------------------------------------------------------------------------------------
// member-display-identity guard (census gate: approval-member-identity-coverage-enumeration.spec
// .ts's "GATE FOR THE NEXT SLICE" disposition on MetaCommentsPanel.vue's :378/:384/:385 fallbacks)
// -----------------------------------------------------------------------------------------------
watch(
  () => {
    const ids: string[] = []
    for (const c of comments.comments.value) {
      if (c.authorId) ids.push(c.authorId)
      for (const m of c.mentions ?? []) ids.push(m)
    }
    return ids
  },
  (ids) => ensureUserNamesResolved(ids),
  { immediate: true },
)

/** Resolved name, or a values-free `成员 N` ordinal (N = first-seen order among THIS list's
 *  distinct authors) — NEVER the raw id. Mirrors ApprovalDetailView.vue's `reducibleAssignees`
 *  ordinal convention (same repo-shipped spelling, `成员 ${ordinal}`). */
const authorDisplayName = computed<Record<string, string>>(() => {
  const seen = new Set<string>()
  const out: Record<string, string> = {}
  let ordinal = 0
  for (const c of comments.comments.value) {
    if (!c.authorId || seen.has(c.authorId)) continue
    seen.add(c.authorId)
    ordinal += 1
    out[c.authorId] = getResolvedUserName(c.authorId) || `成员 ${ordinal}`
  }
  return out
})

const commentsForPanel = computed(() => comments.comments.value.map((c) => ({
  ...c,
  // Always set to a non-empty string — the shared panel's own template falls back to
  // `thread.authorName ?? thread.authorId` when this is undefined, which is EXACTLY the raw-id
  // leak the census gate blocks. Setting it unconditionally here means that fallback path is
  // structurally unreachable for this consumer.
  authorName: authorDisplayName.value[c.authorId] || c.authorId,
})))

const mentionCandidatesForPanel = computed<MentionCandidateInput[]>(() => (
  mentionCandidates.value.map((candidate) => ({
    userId: candidate.id,
    displayName: candidate.name.trim(),
    secondaryLabel: candidate.email || null,
  }))
))

// -----------------------------------------------------------------------------------------------
// mention token extraction for edit prefill (draft already carries `@[Label](id)` tokens
// byte-identical to the composer's own serialization grammar — no separate resolver needed to
// reconstruct the label, it round-trips from the stored content itself).
// -----------------------------------------------------------------------------------------------
function extractMentionTokens(content: string): MetaCommentMentionSuggestion[] {
  const re = /@\[([^\]]+)\]\(([^)]+)\)/g
  const seen = new Set<string>()
  const out: MetaCommentMentionSuggestion[] = []
  let match: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((match = re.exec(content))) {
    const [, label, id] = match
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label })
  }
  return out
}

function handleReplyStart(commentId: string): void {
  editingCommentId.value = null
  replyToCommentId.value = commentId
  draft.value = ''
  composerInitialMentions.value = []
}

function handleEditStart(commentId: string): void {
  const target = comments.comments.value.find((c) => c.id === commentId)
  if (!target || target.deleted === true) return
  replyToCommentId.value = null
  editingCommentId.value = commentId
  draft.value = target.content
  composerInitialMentions.value = extractMentionTokens(target.content)
}

function handleCancel(): void {
  replyToCommentId.value = null
  editingCommentId.value = null
  draft.value = ''
  composerInitialMentions.value = []
}

/** True for the two error codes that mean "the local view is stale" (§2 of the wiring contract):
 *  editing/deleting a comment that was concurrently tombstoned, or one that no longer resolves
 *  under the caller's own authorship. Both re-list rather than leaving a dangling row on screen.
 *  Duck-typed on `.code` (not `instanceof ApprovalApiError`) so this file has no load-bearing
 *  dependency on the `approvals/api` module's class identity — several existing specs mount
 *  ApprovalDetailView.vue with `approvals/api` broadly `vi.mock`'d, and this wrapper's import
 *  graph should not silently require every one of them to also re-export that class. */
function isStaleViewError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code
  return code === 'APPROVAL_COMMENT_DELETED' || code === 'APPROVAL_COMMENT_NOT_FOUND'
}

async function handleSubmit(payload: { content: string; mentions: string[] }): Promise<void> {
  try {
    if (editingCommentId.value) {
      const id = editingCommentId.value
      await comments.updateComment(id, { content: payload.content, mentions: payload.mentions })
      handleCancel()
    } else {
      await comments.addComment({
        ...scopeTarget.value,
        content: payload.content,
        parentId: replyToCommentId.value ?? undefined,
        mentions: payload.mentions,
      })
      handleCancel()
    }
  } catch (e) {
    if (isStaleViewError(e)) await comments.loadComments(scopeTarget.value)
  }
}

async function handleDelete(commentId: string): Promise<void> {
  try {
    await comments.deleteComment(commentId)
  } catch (e) {
    if (!isStaleViewError(e)) return
  }
  // Re-hydrate from the server regardless of outcome — a successful delete's local removal
  // (applyDeletedComment) must be replaced by the real tombstone row; a stale-view error means
  // the local list was already wrong. See §4 "Delete flow — approach (a)".
  await comments.loadComments(scopeTarget.value)
}

function handleRetry(): void {
  void comments.loadComments(scopeTarget.value)
}

async function loadMentionCandidates(): Promise<void> {
  try {
    mentionCandidates.value = await fetchApprovalCommentMentionCandidates(props.instanceId)
  } catch {
    // Degrade to no suggestions — the composer still accepts free-text @mentions typed manually
    // (they just won't autocomplete); never surfaced as a blocking error.
    mentionCandidates.value = []
  }
}

async function activate(): Promise<void> {
  comments.clearComments()
  handleCancel()
  await Promise.all([
    comments.loadComments(scopeTarget.value),
    loadMentionCandidates(),
  ])
}

onMounted(activate)
watch(() => props.instanceId, activate)
</script>

<style scoped>
.approval-comments-panel { display: flex; flex-direction: column; min-height: 200px; }
.approval-comments-panel__truncated {
  padding: 6px 10px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #92610a;
  background: #fff7e6;
  border: 1px solid #ffe1a8;
  border-radius: 6px;
}
</style>
