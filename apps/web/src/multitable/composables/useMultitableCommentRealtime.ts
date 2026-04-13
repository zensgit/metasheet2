import { onBeforeUnmount, watch } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '../../composables/useAuth'
import { getApiBase } from '../../utils/api'
import type { MultitableComment } from '../types'
import { normalizeMultitableComment } from '../api/client'

type CommentEventPayload = {
  spreadsheetId?: string
  containerId?: string
  comment?: Partial<MultitableComment> & {
    containerId?: string
    spreadsheetId?: string
    targetId?: string
    rowId?: string
    targetFieldId?: string | null
  }
  commentId?: string
  targetId?: string
  rowId?: string
  targetFieldId?: string | null
  fieldId?: string | null
  authorId?: string
}

type MaybeReactive<T> = T | { value: T } | (() => T)

type UseMultitableCommentRealtimeOptions = {
  sheetId: MaybeReactive<string | null | undefined>
  selectedRecordId: MaybeReactive<string | null | undefined>
  commentsVisible: MaybeReactive<boolean>
  reloadSelectedRecordComments: () => Promise<void>
  refreshUnreadCount?: () => Promise<void>
}

function readValue<T>(source: MaybeReactive<T>): T {
  if (typeof source === 'function') {
    return (source as () => T)()
  }
  if (source && typeof source === 'object' && 'value' in source) {
    return source.value as T
  }
  return source as T
}

function normalizeRealtimeComment(payload: CommentEventPayload['comment']): MultitableComment | null {
  if (!payload) return null
  const comment = normalizeMultitableComment(payload)
  if (!comment.id || !comment.containerId || !comment.targetId) return null
  return comment
}

function resolveRealtimeTargetId(payload: CommentEventPayload): string | null {
  if (typeof payload.targetId === 'string' && payload.targetId.trim().length > 0) return payload.targetId
  if (typeof payload.rowId === 'string' && payload.rowId.trim().length > 0) return payload.rowId
  const comment = normalizeRealtimeComment(payload.comment)
  if (comment?.targetId) return comment.targetId
  return null
}

export function useMultitableCommentRealtime(options: UseMultitableCommentRealtimeOptions) {
  const auth = useAuth()
  let socket: Socket | null = null
  let activeSheetId: string | null = null
  let currentUserId: string | null = null
  let disconnected = false
  let connectionPromise: Promise<Socket | null> | null = null

  function selectedRecordMatches(rowId: string | null | undefined): boolean {
    const selectedRecordId = readValue(options.selectedRecordId)?.trim()
    const commentsVisible = readValue(options.commentsVisible)
    return Boolean(commentsVisible && selectedRecordId && rowId && selectedRecordId === rowId)
  }

  function shouldReloadForComment(comment: MultitableComment): boolean {
    return selectedRecordMatches(comment.targetId)
  }

  function shouldReloadForRowId(rowId: string | null | undefined): boolean {
    return selectedRecordMatches(rowId)
  }

  async function refreshUnreadIfNeeded(actorId?: string | null) {
    if (actorId && currentUserId && actorId === currentUserId) return
    await options.refreshUnreadCount?.()
  }

  function cleanupSocket() {
    if (socket) {
      if (activeSheetId) {
        socket.emit('leave-sheet', activeSheetId)
      }
      socket.disconnect()
    }
    socket = null
    activeSheetId = null
    currentUserId = null
    connectionPromise = null
  }

  async function ensureSocket(): Promise<Socket | null> {
    if (socket) return socket
    if (connectionPromise) return connectionPromise

    connectionPromise = (async () => {
      try {
        const userId = await auth.getCurrentUserId().catch(() => null)
        if (disconnected) return null
        currentUserId = userId

        const nextSocket = io(getApiBase() || window.location.origin, {
          autoConnect: true,
          transports: ['websocket'],
          query: userId ? { userId } : undefined,
        })

        nextSocket.on('comment:created', (payload: CommentEventPayload) => {
          const comment = normalizeRealtimeComment(payload.comment)
          if (comment && shouldReloadForComment(comment)) {
            void options.reloadSelectedRecordComments()
          }
          void refreshUnreadIfNeeded(comment?.authorId)
        })
        nextSocket.on('comment:updated', (payload: CommentEventPayload) => {
          const comment = normalizeRealtimeComment(payload.comment)
          if (comment && shouldReloadForComment(comment)) {
            void options.reloadSelectedRecordComments()
          }
          void refreshUnreadIfNeeded(comment?.authorId ?? payload.authorId)
        })
        nextSocket.on('comment:resolved', (payload: CommentEventPayload) => {
          const targetId = resolveRealtimeTargetId(payload)
          if (
            typeof payload.commentId === 'string' &&
            payload.commentId.trim().length > 0 &&
            shouldReloadForRowId(targetId)
          ) {
            void options.reloadSelectedRecordComments()
          }
          void refreshUnreadIfNeeded(payload.authorId)
        })
        nextSocket.on('comment:deleted', (payload: CommentEventPayload) => {
          const targetId = resolveRealtimeTargetId(payload)
          if (
            typeof payload.commentId === 'string' &&
            payload.commentId.trim().length > 0 &&
            shouldReloadForRowId(targetId)
          ) {
            void options.reloadSelectedRecordComments()
          }
          void refreshUnreadIfNeeded(payload.authorId)
        })
        nextSocket.on('comment:mention', (payload: CommentEventPayload) => {
          const comment = normalizeRealtimeComment(payload.comment)
          if (comment && shouldReloadForComment(comment)) {
            void options.reloadSelectedRecordComments()
          }
          void refreshUnreadIfNeeded(comment?.authorId)
        })

        socket = nextSocket
        return nextSocket
      } finally {
        connectionPromise = null
      }
    })()

    return connectionPromise
  }

  async function syncSheetRoom() {
    const nextSheetId = readValue(options.sheetId)?.trim() || null

    if (!nextSheetId) {
      cleanupSocket()
      return
    }

    const currentSocket = await ensureSocket()
    if (!currentSocket) return

    if (activeSheetId && activeSheetId !== nextSheetId) {
      currentSocket.emit('leave-sheet', activeSheetId)
    }
    if (activeSheetId !== nextSheetId) {
      currentSocket.emit('join-sheet', nextSheetId)
      activeSheetId = nextSheetId
    }
  }

  watch(
    () => [
      readValue(options.sheetId) ?? '',
      readValue(options.selectedRecordId) ?? '',
      readValue(options.commentsVisible),
    ] as const,
    () => {
      void syncSheetRoom()
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    disconnected = true
    cleanupSocket()
  })

  return {
    reconnect: syncSheetRoom,
    disconnect: cleanupSocket,
  }
}
