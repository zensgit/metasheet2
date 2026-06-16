import { ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MetaCommentsScope, MultitableComment } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'
import { commentLabel } from '../utils/meta-comment-labels'

type CommentsTarget = { containerId: string; targetId: string; targetFieldId?: string | null } | MetaCommentsScope

export function useMultitableComments(client?: MultitableApiClient) {
  const api = client ?? multitableClient
  const { isZh } = useLocale()
  const fallback = (key: Parameters<typeof commentLabel>[0]) => commentLabel(key, isZh.value)
  const comments = ref<MultitableComment[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const submitting = ref(false)
  const resolvingIds = ref<string[]>([])
  const updatingIds = ref<string[]>([])
  const deletingIds = ref<string[]>([])
  // B6: in-flight reaction toggles keyed `${commentId}:${emoji}` (debounces double-clicks).
  const reactingKeys = ref<string[]>([])

  async function loadComments(params: CommentsTarget) {
    loading.value = true
    error.value = null
    try {
      const data = await api.listComments(params)
      comments.value = data.comments ?? []
    } catch (e: any) {
      error.value = e.message ?? fallback('comment.errorLoad')
    } finally {
      loading.value = false
    }
  }

  async function addComment(input: CommentsTarget & { content: string; parentId?: string; mentions?: string[] }) {
    error.value = null
    submitting.value = true
    try {
      const data = await api.createComment(input)
      if (data.comment) comments.value.unshift(data.comment)
      return data.comment ?? null
    } catch (e: any) {
      error.value = e.message ?? fallback('comment.errorAdd')
      throw e
    } finally {
      submitting.value = false
    }
  }

  async function resolveComment(commentId: string) {
    error.value = null
    if (!resolvingIds.value.includes(commentId)) {
      resolvingIds.value = [...resolvingIds.value, commentId]
    }
    try {
      await api.resolveComment(commentId)
      const idx = comments.value.findIndex((c) => c.id === commentId)
      if (idx >= 0) comments.value[idx] = { ...comments.value[idx], resolved: true }
    } catch (e: any) {
      error.value = e.message ?? fallback('comment.errorResolve')
      throw e
    } finally {
      resolvingIds.value = resolvingIds.value.filter((id) => id !== commentId)
    }
  }

  async function updateComment(commentId: string, input: { content: string; mentions?: string[] }) {
    error.value = null
    if (!updatingIds.value.includes(commentId)) {
      updatingIds.value = [...updatingIds.value, commentId]
    }
    try {
      const data = await api.updateComment(commentId, input)
      if (data.comment) upsertComment(data.comment)
      return data.comment ?? null
    } catch (e: any) {
      error.value = e.message ?? fallback('comment.errorUpdate')
      throw e
    } finally {
      updatingIds.value = updatingIds.value.filter((id) => id !== commentId)
    }
  }

  async function deleteComment(commentId: string) {
    error.value = null
    if (!deletingIds.value.includes(commentId)) {
      deletingIds.value = [...deletingIds.value, commentId]
    }
    try {
      await api.deleteComment(commentId)
      applyDeletedComment(commentId)
    } catch (e: any) {
      error.value = e.message ?? fallback('comment.errorDelete')
      throw e
    } finally {
      deletingIds.value = deletingIds.value.filter((id) => id !== commentId)
    }
  }

  // B6: add/remove the caller's emoji reaction. Await-then-mutate (mirrors
  // resolveComment): the endpoints return no reaction data, so on success we
  // locally recompute the comment's reactions aggregate. A re-add of an emoji
  // the user already reacted with (or a remove of one they didn't) is a no-op
  // both server-side (idempotent) and locally.
  async function addReaction(commentId: string, emoji: string) {
    const key = `${commentId}:${emoji}`
    error.value = null
    if (reactingKeys.value.includes(key)) return
    reactingKeys.value = [...reactingKeys.value, key]
    try {
      await api.addReaction(commentId, emoji)
      applyReaction(commentId, emoji, 'add')
    } catch (e: any) {
      error.value = e.message ?? fallback('comment.errorAddReaction')
      throw e
    } finally {
      reactingKeys.value = reactingKeys.value.filter((k) => k !== key)
    }
  }

  async function removeReaction(commentId: string, emoji: string) {
    const key = `${commentId}:${emoji}`
    error.value = null
    if (reactingKeys.value.includes(key)) return
    reactingKeys.value = [...reactingKeys.value, key]
    try {
      await api.removeReaction(commentId, emoji)
      applyReaction(commentId, emoji, 'remove')
    } catch (e: any) {
      error.value = e.message ?? fallback('comment.errorRemoveReaction')
      throw e
    } finally {
      reactingKeys.value = reactingKeys.value.filter((k) => k !== key)
    }
  }

  /** Local recompute of one comment's reactions aggregate after a successful toggle. */
  function applyReaction(commentId: string, emoji: string, mode: 'add' | 'remove') {
    const index = comments.value.findIndex((item) => item.id === commentId)
    if (index < 0) return
    const current = comments.value[index].reactions ?? []
    const existing = current.find((r) => r.emoji === emoji)
    let next = current
    if (mode === 'add') {
      if (!existing) {
        next = [...current, { emoji, count: 1, reactedByMe: true }]
      } else if (!existing.reactedByMe) {
        next = current.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, reactedByMe: true } : r))
      } // already reactedByMe → no-op
    } else {
      if (existing?.reactedByMe) {
        const count = Math.max(0, existing.count - 1)
        next = count === 0
          ? current.filter((r) => r.emoji !== emoji)
          : current.map((r) => (r.emoji === emoji ? { ...r, count, reactedByMe: false } : r))
      } // not reactedByMe → no-op
    }
    comments.value[index] = { ...comments.value[index], reactions: next }
  }

  function clearComments() {
    comments.value = []
    error.value = null
    updatingIds.value = []
    deletingIds.value = []
    reactingKeys.value = []
  }

  function upsertComment(comment: MultitableComment) {
    const index = comments.value.findIndex((item) => item.id === comment.id)
    if (index >= 0) {
      const merged = { ...comments.value[index], ...comment }
      // B6: edit/realtime comment payloads are NOT reaction-hydrated (only
      // getComments hydrates reactions), so an incoming `undefined` must not
      // wipe the reactions already shown — preserve the existing aggregate.
      if (comment.reactions === undefined) merged.reactions = comments.value[index].reactions
      comments.value[index] = merged
      return
    }
    comments.value = [comment, ...comments.value]
  }

  function applyResolvedComment(commentId: string) {
    const index = comments.value.findIndex((item) => item.id === commentId)
    if (index >= 0) {
      comments.value[index] = { ...comments.value[index], resolved: true }
    }
  }

  function applyUpdatedComment(comment: MultitableComment) {
    upsertComment(comment)
  }

  function applyDeletedComment(commentId: string) {
    comments.value = comments.value.filter((item) => item.id !== commentId)
  }

  return {
    comments,
    loading,
    error,
    submitting,
    resolvingIds,
    updatingIds,
    deletingIds,
    reactingKeys,
    loadComments,
    addComment,
    updateComment,
    deleteComment,
    resolveComment,
    addReaction,
    removeReaction,
    applyReaction,
    clearComments,
    upsertComment,
    applyResolvedComment,
    applyUpdatedComment,
    applyDeletedComment,
  }
}
