import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '../../composables/useAuth'
import { getApiBase } from '../../utils/api'
import type { MultitableSheetPresence } from '../types'

type MaybeReactive<T> = T | { value: T } | (() => T)

type SheetPresenceEventPayload = Partial<MultitableSheetPresence> & {
  users?: Array<{ id?: string }>
}

type UseMultitableSheetPresenceOptions = {
  sheetId: MaybeReactive<string | null | undefined>
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

function normalizeSheetPresence(payload: SheetPresenceEventPayload | null | undefined): MultitableSheetPresence | null {
  if (!payload) return null
  const sheetId = typeof payload.sheetId === 'string' ? payload.sheetId.trim() : ''
  if (!sheetId) return null

  const users = Array.isArray(payload.users)
    ? payload.users
      .map((user) => (typeof user?.id === 'string' ? user.id.trim() : ''))
      .filter((id) => id.length > 0)
      .map((id) => ({ id }))
    : []

  return {
    sheetId,
    activeCount: typeof payload.activeCount === 'number' ? payload.activeCount : users.length,
    users,
  }
}

export function useMultitableSheetPresence(options: UseMultitableSheetPresenceOptions) {
  const auth = useAuth()
  const presence = ref<MultitableSheetPresence | null>(null)
  const currentUserId = ref<string | null>(null)
  let socket: Socket | null = null
  let activeSheetId: string | null = null
  let disconnected = false
  let connectionPromise: Promise<Socket | null> | null = null

  const activeUsers = computed(() => presence.value?.users ?? [])
  const activeCollaborators = computed(() => {
    const selfId = currentUserId.value
    if (!selfId) return activeUsers.value
    return activeUsers.value.filter((user) => user.id !== selfId)
  })
  const activeCollaboratorCount = computed(() => activeCollaborators.value.length)

  function clearPresence(sheetId?: string | null) {
    if (!sheetId || presence.value?.sheetId === sheetId) {
      presence.value = null
    }
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
    connectionPromise = null
    clearPresence()
  }

  async function ensureSocket(): Promise<Socket | null> {
    if (socket) return socket
    if (connectionPromise) return connectionPromise

    connectionPromise = (async () => {
      try {
        const userId = await auth.getCurrentUserId().catch(() => null)
        if (disconnected) return null
        currentUserId.value = userId

        const nextSocket = io(getApiBase() || window.location.origin, {
          autoConnect: true,
          transports: ['websocket'],
          query: userId ? { userId } : undefined,
        })

        nextSocket.on('sheet:presence', (payload: SheetPresenceEventPayload) => {
          const nextPresence = normalizeSheetPresence(payload)
          if (!nextPresence || nextPresence.sheetId !== activeSheetId) return
          presence.value = nextPresence
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
      clearPresence(activeSheetId)
    }
    if (activeSheetId !== nextSheetId) {
      currentSocket.emit('join-sheet', nextSheetId)
      activeSheetId = nextSheetId
    }
  }

  watch(
    () => readValue(options.sheetId) ?? '',
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
    presence,
    activeUsers,
    activeCollaborators,
    activeCollaboratorCount,
    reconnect: syncSheetRoom,
    disconnect: cleanupSocket,
  }
}
