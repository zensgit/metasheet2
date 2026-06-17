import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '../../composables/useAuth'
import { getApiBase } from '../../utils/api'
import type { MultitableSheetPresence } from '../types'
import {
  applyCursorEvent,
  cursorsByCell,
  pruneCursors,
  type RemoteCellCursor,
  type SheetCursorEvent,
} from '../utils/sheet-cursor-state'

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

  // Live cell-cursors: remote collaborators' active cells (keyed by userId, self excluded). `byCell`
  // indexes them for O(1) per-cell lookup in the grid render.
  const remoteCursors = ref<Map<string, RemoteCellCursor>>(new Map())
  const remoteCursorsByCell = computed(() => cursorsByCell(remoteCursors.value))
  let localCursorKey: string | null = null

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

  function clearRemoteCursors() {
    if (remoteCursors.value.size > 0) remoteCursors.value = new Map()
    localCursorKey = null
  }

  // Emit the local active cell to the sheet room (deduped — only on actual change). null/null clears it
  // (blur). Presentational only: the server relays it; no data is mutated.
  function setLocalCursor(recordId: string | null, fieldId: string | null) {
    const key = recordId && fieldId ? `${recordId}:${fieldId}` : null
    if (key === localCursorKey) return
    localCursorKey = key
    if (socket && activeSheetId) {
      socket.emit('sheet:cursor', { sheetId: activeSheetId, recordId: recordId ?? null, fieldId: fieldId ?? null })
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
    clearRemoteCursors()
  }

  async function ensureSocket(): Promise<Socket | null> {
    if (socket) return socket
    if (connectionPromise) return connectionPromise

    connectionPromise = (async () => {
      try {
        const userId = await auth.getCurrentUserId().catch(() => null)
        if (disconnected) return null
        currentUserId.value = userId
        const token = auth.getToken()

        const nextSocket = io(getApiBase() || window.location.origin, {
          autoConnect: true,
          transports: ['websocket'],
          auth: token ? { token } : undefined,
        })

        nextSocket.on('sheet:presence', (payload: SheetPresenceEventPayload) => {
          const nextPresence = normalizeSheetPresence(payload)
          if (!nextPresence || nextPresence.sheetId !== activeSheetId) return
          presence.value = nextPresence
        })

        nextSocket.on('sheet:cursor', (payload: SheetCursorEvent & { sheetId?: unknown }) => {
          if (typeof payload?.sheetId === 'string' && payload.sheetId.trim() !== activeSheetId) return
          remoteCursors.value = applyCursorEvent(remoteCursors.value, payload, currentUserId.value)
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
      clearRemoteCursors()
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

  // Backstop prune: a collaborator who dropped out of presence can't keep a live cursor (the server also
  // broadcasts a clear on disconnect/leave; this covers a missed clear). Safe because join-presence
  // always precedes that user's first cursor event.
  watch(
    () => presence.value?.users?.map((user) => user.id).join(',') ?? '',
    () => {
      remoteCursors.value = pruneCursors(remoteCursors.value, presence.value?.users?.map((user) => user.id) ?? [])
    },
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
    remoteCursors,
    remoteCursorsByCell,
    setLocalCursor,
    reconnect: syncSheetRoom,
    disconnect: cleanupSocket,
  }
}
