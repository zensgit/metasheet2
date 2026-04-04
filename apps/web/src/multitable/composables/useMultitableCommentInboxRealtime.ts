import { onBeforeUnmount, onMounted, watch } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '../../composables/useAuth'
import { resolveMultitableCommentsRealtimeBaseUrl } from '../realtime/comments-realtime'

type UseMultitableCommentInboxRealtimeOptions = {
  refreshInbox: () => Promise<void>
  sheetIds?: () => string[]
}

export function useMultitableCommentInboxRealtime(options: UseMultitableCommentInboxRealtimeOptions) {
  const auth = useAuth()
  let currentUserId: string | null = null
  let socket: Socket | null = null
  let disconnected = false
  let connectionPromise: Promise<Socket | null> | null = null
  let refreshInFlight = false
  let refreshQueued = false
  let desiredSheetIds: string[] = []
  const joinedSheetIds = new Set<string>()

  function normalizeSheetIds(sheetIds: string[]): string[] {
    return [...new Set(
      sheetIds
        .map((sheetId) => sheetId.trim())
        .filter((sheetId) => sheetId.length > 0),
    )].sort()
  }

  async function flushRefreshQueue(): Promise<void> {
    if (refreshInFlight) {
      refreshQueued = true
      return
    }

    refreshInFlight = true
    try {
      await options.refreshInbox()
    } finally {
      refreshInFlight = false
      if (refreshQueued) {
        refreshQueued = false
        await flushRefreshQueue()
      }
    }
  }

  function syncSheetSubscriptions(nextSheetIds = desiredSheetIds) {
    if (!socket?.connected) return

    const nextSet = new Set(nextSheetIds)
    for (const sheetId of joinedSheetIds) {
      if (nextSet.has(sheetId)) continue
      socket.emit('leave-comment-sheet', { spreadsheetId: sheetId })
      joinedSheetIds.delete(sheetId)
    }

    for (const sheetId of nextSet) {
      if (joinedSheetIds.has(sheetId)) continue
      socket.emit('join-comment-sheet', { spreadsheetId: sheetId })
      joinedSheetIds.add(sheetId)
    }
  }

  function cleanupSocket() {
    if (socket?.connected) {
      for (const sheetId of joinedSheetIds) {
        socket.emit('leave-comment-sheet', { spreadsheetId: sheetId })
      }
    }
    joinedSheetIds.clear()
    socket?.disconnect()
    socket = null
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

        const nextSocket = io(resolveMultitableCommentsRealtimeBaseUrl(), {
          path: '/socket.io',
          transports: ['websocket', 'polling'],
          query: userId ? { userId } : undefined,
        })

        nextSocket.on('connect', () => {
          syncSheetSubscriptions()
        })
        nextSocket.on('comment:mention', () => {
          void flushRefreshQueue()
        })
        nextSocket.on('comment:created', (payload?: { comment?: { authorId?: string | null } | null }) => {
          if (payload?.comment?.authorId && currentUserId && payload.comment.authorId === currentUserId) return
          void flushRefreshQueue()
        })
        nextSocket.on('comment:resolved', () => {
          void flushRefreshQueue()
        })

        socket = nextSocket
        syncSheetSubscriptions()
        return nextSocket
      } finally {
        connectionPromise = null
      }
    })()

    return connectionPromise
  }

  onMounted(() => {
    void ensureSocket()
  })

  watch(
    () => normalizeSheetIds(options.sheetIds?.() ?? []),
    (sheetIds) => {
      desiredSheetIds = sheetIds
      syncSheetSubscriptions(sheetIds)
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    disconnected = true
    cleanupSocket()
  })

  return {
    reconnect: ensureSocket,
    disconnect: cleanupSocket,
  }
}
