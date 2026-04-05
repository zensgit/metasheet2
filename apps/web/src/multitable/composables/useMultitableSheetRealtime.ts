import { onBeforeUnmount, watch } from 'vue'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '../../composables/useAuth'
import { getApiBase } from '../../utils/api'

type MaybeReactive<T> = T | { value: T } | (() => T)

type SheetOpEvent = {
  type?: string
  data?: {
    spreadsheetId?: string
    actorId?: string | null
    kind?: string
    recordId?: string
    recordIds?: string[]
    fieldIds?: string[]
    recordPatches?: Array<{
      recordId?: string
      version?: number
      patch?: Record<string, unknown> | null
    }>
  } | null
}

type SheetOpRecordPatch = {
  recordId: string
  version?: number
  patch: Record<string, unknown>
}

type NormalizedSheetOpEvent = {
  spreadsheetId: string
  actorId: string
  kind: string
  recordId: string
  recordIds: string[]
  fieldIds: string[]
  recordPatches: SheetOpRecordPatch[]
}

type UseMultitableSheetRealtimeOptions = {
  sheetId: MaybeReactive<string | null | undefined>
  selectedRecordId?: MaybeReactive<string | null | undefined>
  visibleRecordIds?: MaybeReactive<string[] | null | undefined>
  structuralFieldIds?: MaybeReactive<string[] | null | undefined>
  reloadCurrentSheetPage: () => Promise<void>
  reloadSelectedRecordContext?: (recordId: string) => Promise<void>
  applyRemoteRecordPatch?: (payload: {
    recordId: string
    version?: number
    fieldIds: string[]
    patch: Record<string, unknown>
  }) => Promise<boolean> | boolean
  mergeRemoteRecord?: (recordId: string) => Promise<boolean>
  removeLocalRecord?: (recordId: string) => Promise<boolean> | boolean
}

function readValue<T>(source: MaybeReactive<T>): T {
  if (typeof source === 'function') return (source as () => T)()
  if (source && typeof source === 'object' && 'value' in source) return source.value as T
  return source as T
}

function normalizeSheetOpEvent(payload: SheetOpEvent | null | undefined) {
  const data = payload?.data
  const spreadsheetId = typeof data?.spreadsheetId === 'string' ? data.spreadsheetId.trim() : ''
  const actorId = typeof data?.actorId === 'string' ? data.actorId.trim() : ''
  const recordId = typeof data?.recordId === 'string' ? data.recordId.trim() : ''
  const recordIds = Array.isArray(data?.recordIds)
    ? data.recordIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  const fieldIds = Array.isArray(data?.fieldIds)
    ? data.fieldIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  const recordPatches = Array.isArray(data?.recordPatches)
    ? data.recordPatches.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const recordId = typeof entry.recordId === 'string' ? entry.recordId.trim() : ''
      const patch = entry.patch && typeof entry.patch === 'object' && !Array.isArray(entry.patch)
        ? { ...entry.patch }
        : null
      if (!recordId || !patch) return []
      return [{
        recordId,
        version: typeof entry.version === 'number' ? entry.version : undefined,
        patch,
      }]
    })
    : []
  return {
    spreadsheetId,
    actorId,
    kind: typeof data?.kind === 'string' ? data.kind : '',
    recordId,
    recordIds,
    fieldIds,
    recordPatches,
  }
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}

function intersects(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false
  const rightSet = new Set(right)
  return left.some((value) => rightSet.has(value))
}

function buildTargetRecordIds(event: NormalizedSheetOpEvent): string[] {
  return uniqueIds([
    ...(event.recordId ? [event.recordId] : []),
    ...event.recordIds,
  ])
}

function buildRecordPatchMap(event: NormalizedSheetOpEvent): Map<string, SheetOpRecordPatch> {
  return new Map(event.recordPatches.map((entry) => [entry.recordId, entry]))
}

export function useMultitableSheetRealtime(options: UseMultitableSheetRealtimeOptions) {
  const auth = useAuth()
  let socket: Socket | null = null
  let activeSheetId: string | null = null
  let currentUserId: string | null = null
  let disconnected = false
  let connectionPromise: Promise<Socket | null> | null = null
  let refreshInFlight = false
  let refreshQueued = false
  let queuedSelectedRecordId: string | null = null
  let eventChain: Promise<void> = Promise.resolve()

  function cleanupSocket() {
    if (socket) {
      if (activeSheetId) socket.emit('leave-sheet', activeSheetId)
      socket.disconnect()
    }
    socket = null
    activeSheetId = null
    currentUserId = null
    connectionPromise = null
  }

  async function flushRefreshQueue(selectedRecordId: string | null) {
    if (refreshInFlight) {
      refreshQueued = true
      if (selectedRecordId) queuedSelectedRecordId = selectedRecordId
      return
    }

    refreshInFlight = true
    try {
      await options.reloadCurrentSheetPage()
      if (selectedRecordId) {
        await options.reloadSelectedRecordContext?.(selectedRecordId)
      }
    } finally {
      refreshInFlight = false
      if (refreshQueued) {
        const nextSelectedRecordId = queuedSelectedRecordId
        refreshQueued = false
        queuedSelectedRecordId = null
        await flushRefreshQueue(nextSelectedRecordId)
      }
    }
  }

  async function handleEvent(event: NormalizedSheetOpEvent) {
    const selectedRecordId = readValue(options.selectedRecordId ?? null)?.trim() || null
    const visibleRecordIds = uniqueIds(readValue(options.visibleRecordIds ?? []) ?? [])
    const structuralFieldIds = uniqueIds(readValue(options.structuralFieldIds ?? []) ?? [])
    const targetRecordIds = buildTargetRecordIds(event)
    const recordPatchMap = buildRecordPatchMap(event)
    const localTargetRecordIds = targetRecordIds.filter((recordId) => (
      visibleRecordIds.includes(recordId) || (selectedRecordId != null && recordId === selectedRecordId)
    ))
    const shouldRefreshSelectedRecord = Boolean(
      selectedRecordId &&
      targetRecordIds.includes(selectedRecordId),
    )

    if (event.kind === 'record-created') {
      await flushRefreshQueue(shouldRefreshSelectedRecord ? selectedRecordId : null)
      return
    }

    if (event.kind === 'record-deleted') {
      let handled = false
      for (const recordId of localTargetRecordIds) {
        const removed = await options.removeLocalRecord?.(recordId)
        handled = Boolean(removed) || handled
      }
      if (!handled && targetRecordIds.length > 0) return
      return
    }

    if (!localTargetRecordIds.length) return

    if (intersects(event.fieldIds, structuralFieldIds)) {
      await flushRefreshQueue(shouldRefreshSelectedRecord ? selectedRecordId : null)
      return
    }

    const unresolvedRecordIds: string[] = []
    for (const recordId of localTargetRecordIds) {
      const patchEntry = recordPatchMap.get(recordId)
      if (!patchEntry || !options.applyRemoteRecordPatch) {
        unresolvedRecordIds.push(recordId)
        continue
      }
      const applied = await options.applyRemoteRecordPatch({
        recordId,
        version: patchEntry.version,
        fieldIds: event.fieldIds,
        patch: patchEntry.patch,
      })
      if (!applied) unresolvedRecordIds.push(recordId)
    }

    if (unresolvedRecordIds.length === 0) return

    if (!options.mergeRemoteRecord) {
      await flushRefreshQueue(shouldRefreshSelectedRecord ? selectedRecordId : null)
      return
    }

    let mergeHandled = false
    for (const recordId of unresolvedRecordIds) {
      const merged = await options.mergeRemoteRecord(recordId)
      mergeHandled = merged || mergeHandled
    }

    if (!mergeHandled) {
      await flushRefreshQueue(shouldRefreshSelectedRecord ? selectedRecordId : null)
    }
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

        nextSocket.on('sheet:op', (payload: SheetOpEvent) => {
          const event = normalizeSheetOpEvent(payload)
          if (!event.spreadsheetId || event.spreadsheetId !== activeSheetId) return
          if (event.actorId && currentUserId && event.actorId === currentUserId) return
          eventChain = eventChain
            .then(() => handleEvent(event))
            .catch(() => undefined)
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
    reconnect: syncSheetRoom,
    disconnect: cleanupSocket,
  }
}
