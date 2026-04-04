import { onScopeDispose, ref } from 'vue'
import type { MultitableComment, MultitableCommentPresenceSummary } from '../types'
import { MultitableApiClient, multitableClient, normalizeMultitableComment } from '../api/client'
import {
  subscribeToMultitableCommentsRealtime,
  type MultitableCommentCreatedEvent,
  type MultitableCommentResolvedEvent,
  type MultitableCommentsRealtimeScope,
  type MultitableCommentsRealtimeSubscribe,
} from '../realtime/comments-realtime'

type PresenceScope = {
  containerId: string
  targetIds: string[]
}

export interface UseMultitableCommentPresenceOptions {
  subscribeRealtime?: MultitableCommentsRealtimeSubscribe | null
}

function buildRealtimeScope(scope: PresenceScope | null): MultitableCommentsRealtimeScope | null {
  if (!scope) return null
  return {
    containerId: scope.containerId,
    targetIds: scope.targetIds,
  }
}

function buildRealtimeScopeKey(scope: MultitableCommentsRealtimeScope | null) {
  if (!scope) return null
  return `${scope.containerId}::${scope.targetIds.join(',')}`
}

function normalizeTargetIds(targetIds: string[]) {
  return [...new Set(targetIds.map((targetId) => targetId.trim()).filter((targetId) => targetId.length > 0))].sort()
}

function sameScope(left: PresenceScope | null, right: PresenceScope | null) {
  if (!left || !right) return left === right
  if (left.containerId !== right.containerId || left.targetIds.length !== right.targetIds.length) return false
  return left.targetIds.every((targetId, index) => targetId === right.targetIds[index])
}

function buildEmptyPresenceSummary(containerId: string, targetId: string): MultitableCommentPresenceSummary {
  return {
    containerId,
    targetId,
    spreadsheetId: containerId,
    rowId: targetId,
    unresolvedCount: 0,
    fieldCounts: {},
    mentionedCount: 0,
    mentionedFieldCounts: {},
  }
}

export function useMultitableCommentPresence(client?: MultitableApiClient, options?: UseMultitableCommentPresenceOptions) {
  const api = client ?? multitableClient
  const subscribeRealtime = options?.subscribeRealtime ?? subscribeToMultitableCommentsRealtime
  const presenceByRecordId = ref<Record<string, MultitableCommentPresenceSummary>>({})
  const loading = ref(false)
  const error = ref<string | null>(null)
  let activeScope: PresenceScope | null = null
  let activeTargetIdSet = new Set<string>()
  let activeLoadVersion = 0
  let activeRealtimeScopeKey: string | null = null
  let unsubscribeRealtime: (() => void) | null = null
  let refreshInFlight = false
  let refreshQueued = false

  function stopRealtimeSubscription() {
    unsubscribeRealtime?.()
    unsubscribeRealtime = null
    activeRealtimeScopeKey = null
  }

  function ensureRealtimeSubscription() {
    const realtimeScope = buildRealtimeScope(activeScope)
    const nextScopeKey = buildRealtimeScopeKey(realtimeScope)
    if (!subscribeRealtime || !realtimeScope || !nextScopeKey) {
      stopRealtimeSubscription()
      return
    }
    if (unsubscribeRealtime && activeRealtimeScopeKey === nextScopeKey) return
    stopRealtimeSubscription()
    unsubscribeRealtime = subscribeRealtime(realtimeScope, {
      onCommentCreated: handleRealtimeCreated,
      onCommentResolved: handleRealtimeResolved,
    })
    activeRealtimeScopeKey = nextScopeKey
  }

  function replacePresence(items: MultitableCommentPresenceSummary[]) {
    presenceByRecordId.value = Object.fromEntries(items.map((summary) => [summary.targetId, summary]))
  }

  async function refreshActivePresence() {
    if (!activeScope || !activeScope.targetIds.length) return
    if (refreshInFlight) {
      refreshQueued = true
      return
    }
    refreshInFlight = true
    try {
      const scopeAtStart = activeScope
      const data = await api.listCommentPresence({
        containerId: scopeAtStart.containerId,
        targetIds: scopeAtStart.targetIds,
      })
      if (!sameScope(activeScope, scopeAtStart)) return
      replacePresence(data.items ?? [])
    } catch {
      // Keep optimistic state if background refresh fails.
    } finally {
      refreshInFlight = false
      if (refreshQueued) {
        refreshQueued = false
        void refreshActivePresence()
      }
    }
  }

  function handleRealtimeCreated(payload: MultitableCommentCreatedEvent) {
    const comment = payload.comment && typeof payload.comment === 'object'
      ? normalizeMultitableComment(payload.comment as Partial<MultitableComment>)
      : null
    if (!comment || !activeScope || comment.containerId !== activeScope.containerId || !activeTargetIdSet.has(comment.targetId)) return

    const current = presenceByRecordId.value[comment.targetId] ?? buildEmptyPresenceSummary(comment.containerId, comment.targetId)
    const nextFieldCounts = { ...current.fieldCounts }
    if (comment.fieldId) {
      nextFieldCounts[comment.fieldId] = (nextFieldCounts[comment.fieldId] ?? 0) + 1
    }
    presenceByRecordId.value = {
      ...presenceByRecordId.value,
      [comment.targetId]: {
        ...current,
        unresolvedCount: current.unresolvedCount + 1,
        fieldCounts: nextFieldCounts,
      },
    }
    void refreshActivePresence()
  }

  function handleRealtimeResolved(payload: MultitableCommentResolvedEvent) {
    const spreadsheetId = typeof payload.spreadsheetId === 'string' ? payload.spreadsheetId : null
    const rowId = typeof payload.rowId === 'string' ? payload.rowId : null
    const fieldId = typeof payload.fieldId === 'string' ? payload.fieldId : null
    if (!activeScope || !rowId) return
    if (spreadsheetId && spreadsheetId !== activeScope.containerId) return
    if (!activeTargetIdSet.has(rowId)) return

    const current = presenceByRecordId.value[rowId]
    if (!current) return

    const nextFieldCounts = { ...current.fieldCounts }
    if (fieldId && nextFieldCounts[fieldId]) {
      const nextCount = nextFieldCounts[fieldId] - 1
      if (nextCount > 0) nextFieldCounts[fieldId] = nextCount
      else delete nextFieldCounts[fieldId]
    }
    const unresolvedCount = Math.max(0, current.unresolvedCount - 1)
    const nextPresence = { ...presenceByRecordId.value }

    if (unresolvedCount === 0) {
      delete nextPresence[rowId]
    } else {
      nextPresence[rowId] = {
        ...current,
        unresolvedCount,
        fieldCounts: nextFieldCounts,
      }
    }

    presenceByRecordId.value = nextPresence
    void refreshActivePresence()
  }

  async function loadPresence(params: { containerId: string; targetIds: string[] }) {
    const targetIds = normalizeTargetIds(params.targetIds)
    const scope = { containerId: params.containerId, targetIds }
    const loadVersion = ++activeLoadVersion
    activeScope = scope
    activeTargetIdSet = new Set(targetIds)
    error.value = null

    if (!targetIds.length) {
      stopRealtimeSubscription()
      presenceByRecordId.value = {}
      loading.value = false
      return
    }

    loading.value = true
    ensureRealtimeSubscription()
    try {
      const data = await api.listCommentPresence({ containerId: params.containerId, targetIds })
      if (loadVersion !== activeLoadVersion || !sameScope(activeScope, scope)) return
      replacePresence(data.items ?? [])
    } catch (e: any) {
      if (loadVersion !== activeLoadVersion || !sameScope(activeScope, scope)) return
      error.value = e.message ?? 'Failed to load comment presence'
    } finally {
      if (loadVersion === activeLoadVersion) {
        loading.value = false
      }
    }
  }

  function clearPresence() {
    activeLoadVersion += 1
    activeScope = null
    activeTargetIdSet = new Set()
    stopRealtimeSubscription()
    refreshInFlight = false
    refreshQueued = false
    presenceByRecordId.value = {}
    loading.value = false
    error.value = null
  }

  onScopeDispose(() => {
    stopRealtimeSubscription()
  }, true)

  return {
    presenceByRecordId,
    loading,
    error,
    loadPresence,
    clearPresence,
  }
}
