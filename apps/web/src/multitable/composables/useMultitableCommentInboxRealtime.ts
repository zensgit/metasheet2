import { onBeforeUnmount, onMounted } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '../../composables/useAuth'
import { resolveMultitableCommentsRealtimeBaseUrl } from '../realtime/comments-realtime'

type UseMultitableCommentInboxRealtimeOptions = {
  refreshInbox: () => Promise<void>
}

type CommentActivityPayload = {
  kind?: 'created' | 'resolved'
  authorId?: string | null
}

export function useMultitableCommentInboxRealtime(options: UseMultitableCommentInboxRealtimeOptions) {
  const auth = useAuth()
  let currentUserId: string | null = null
  let socket: Socket | null = null
  let disconnected = false
  let connectionPromise: Promise<Socket | null> | null = null
  let refreshInFlight = false
  let refreshQueued = false

  function emitInboxJoin(target: Pick<Socket, 'emit'> | null | undefined) {
    if (typeof target?.emit === 'function') target.emit('join-comment-inbox')
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

  function cleanupSocket() {
    if (socket?.connected) socket.emit('leave-comment-inbox')
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
          emitInboxJoin(nextSocket)
        })
        nextSocket.on('comment:mention', () => {
          void flushRefreshQueue()
        })
        nextSocket.on('comment:activity', (payload?: CommentActivityPayload) => {
          if (payload?.kind === 'created' && payload.authorId && currentUserId && payload.authorId === currentUserId) return
          void flushRefreshQueue()
        })

        socket = nextSocket
        emitInboxJoin(nextSocket)
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

  onBeforeUnmount(() => {
    disconnected = true
    cleanupSocket()
  })

  return {
    reconnect: ensureSocket,
    disconnect: cleanupSocket,
  }
}
