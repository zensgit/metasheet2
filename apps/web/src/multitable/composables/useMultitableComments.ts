import { ref } from 'vue'
import type { MultitableComment } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'

export function useMultitableComments(client?: MultitableApiClient) {
  const api = client ?? multitableClient
  const comments = ref<MultitableComment[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const submitting = ref(false)
  const resolvingIds = ref<string[]>([])

  async function loadComments(params: { containerId: string; targetId: string }) {
    loading.value = true
    error.value = null
    try {
      const data = await api.listComments(params)
      comments.value = data.comments ?? []
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load comments'
    } finally {
      loading.value = false
    }
  }

  async function addComment(input: { containerId: string; targetId: string; content: string }) {
    error.value = null
    submitting.value = true
    try {
      const data = await api.createComment(input)
      if (data.comment) comments.value.unshift(data.comment)
      return data.comment ?? null
    } catch (e: any) {
      error.value = e.message ?? 'Failed to add comment'
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
      error.value = e.message ?? 'Failed to resolve comment'
      throw e
    } finally {
      resolvingIds.value = resolvingIds.value.filter((id) => id !== commentId)
    }
  }

  function clearComments() {
    comments.value = []
    error.value = null
  }

  return { comments, loading, error, submitting, resolvingIds, loadComments, addComment, resolveComment, clearComments }
}
