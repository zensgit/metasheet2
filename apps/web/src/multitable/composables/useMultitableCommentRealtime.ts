import { onBeforeUnmount, watch } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '../../composables/useAuth'
import { getApiBase } from '../../utils/api'
import type { MultitableComment } from '../types'

type CommentEventPayload = {
  spreadsheetId?: string
  comment?: Partial<MultitableComment> & {
    spreadsheetId?: string
    rowId?: string
  }
  commentId?: string
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
  const id = typeof payload.id === 'string' ? payload.id : ''
  const containerId = typeof payload.containerId === 'string'
    ? payload.containerId
    : typeof payload.spreadsheetId === 'string'
      ? payload.spreadsheetId
      : ''
  const targetId = typeof payload.targetId === 'string'
    ? payload.targetId
    : typeof payload.rowId === 'string'
      ? payload.rowId
      : ''
  if (!id || !containerId || !targetId) return null

  return {
    id,
    containerId,
    targetId,
    fieldId: typeof payload.fieldId === 'string' ? payload.fieldId : null,
    parentId: typeof payload.parentId === 'string' ? payload.parentId : undefined,
    mentions: Array.isArray(payload.mentions) ? payload.mentions.filter((value): value is string => typeof value === 'string') : [],
    authorId: typeof payload.authorId === 'string' ? payload.authorId : '',
    authorName: typeof payload.authorName === 'string' ? payload.authorName : undefined,
    content: typeof payload.content === 'string' ? payload.content : '',
    resolved: payload.resolved === true,
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : new Date().toISOString(),
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : undefined,
  }
}

export function useMultitableCommentRealtime(options: UseMultitableCommentRealtimeOptions) {
  const auth = useAuth()
  let socket: Socket | null = null
  let activeSheetId: string | null = null
  let currentUserId: string | null = null
  let disconnected = false
  let connectionPromise: Promise<Socket | null> | null = null

  function shouldReloadForComment(comment: MultitableComment): boolean {
    const selectedRecordId = readValue(options.selectedRecordId)?.trim()
    const commentsVisible = readValue(options.commentsVisible)
    return Boolean(commentsVisible && selectedRecordId && selectedRecordId === comment.targetId)
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
        })
        nextSocket.on('comment:resolved', (payload: CommentEventPayload) => {
          const selectedRecordId = readValue(options.selectedRecordId)?.trim()
          if (
            typeof payload.commentId === 'string' &&
            payload.commentId.trim().length > 0 &&
            selectedRecordId &&
            readValue(options.commentsVisible)
          ) {
            void options.reloadSelectedRecordComments()
          }
        })
        nextSocket.on('comment:mention', (payload: CommentEventPayload) => {
          const comment = normalizeRealtimeComment(payload.comment)
          if (comment && shouldReloadForComment(comment)) {
            void options.reloadSelectedRecordComments()
          }
          if (comment && comment.authorId !== currentUserId) {
            void options.refreshUnreadCount?.()
          }
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
