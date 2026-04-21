import { computed, ref, shallowRef, onUnmounted, watch } from 'vue'
import type { Ref } from 'vue'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { io as socketIO, type Socket } from 'socket.io-client'
import { useAuth } from '../../composables/useAuth'
import type { YjsRecordPresence, YjsPresenceUser } from '../types'

const MSG_SYNC = 0

function handleSyncMessage(
  doc: Y.Doc,
  socket: Socket,
  recordId: string,
  message: Uint8Array,
): void {
  const decoder = decoding.createDecoder(message)
  const messageType = decoding.readVarUint(decoder)

  if (messageType === MSG_SYNC) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.readSyncMessage(decoder, encoder, doc, 'server')

    const reply = encoding.toUint8Array(encoder)
    if (reply.length > 1) {
      socket.emit('yjs:message', { recordId, data: Array.from(reply) })
    }
  }
}

/**
 * Composable that manages a Yjs document bound to a specific record,
 * connected via Socket.IO /yjs namespace.
 *
 * Scope: single record, text fields with minimal-diff edits (see
 * `useYjsTextField` for the diff semantics), disconnect/reconnect
 * recovery. Concurrent edits to different ranges of the same field
 * merge per-range via Yjs CRDT; overlapping edits interleave at the
 * nearest common anchor.
 */
export interface UseYjsDocumentOptions {
  /**
   * Register Vue's onUnmounted cleanup automatically. Dynamic/lazy callers
   * may instantiate this composable after setup(), where onUnmounted is not
   * available; those callers must pass false and call dispose() themselves.
   */
  registerUnmount?: boolean
}

export function useYjsDocument(recordId: Ref<string | null>, options: UseYjsDocumentOptions = {}) {
  const doc = shallowRef<Y.Doc | null>(null)
  const connected = ref(false)
  const synced = ref(false)
  const error = ref<string | null>(null)
  const presence = ref<YjsRecordPresence | null>(null)
  const currentUserId = ref<string | null>(null)

  const auth = useAuth()
  let socket: Socket | null = null
  let currentRecordId: string | null = null
  /**
   * Monotonically-increasing generation counter for connect()/disconnect()
   * cycles. Every connect() bumps it; every await path checks `connectGen`
   * against a captured copy and aborts if they differ. This closes the
   * race where `disconnect()` fires while `getCurrentUserId()` is in
   * flight — without the guard, the resolved promise would proceed to
   * create a socket that the caller has already marked stale.
   */
  let connectGen = 0

  function normalizePresenceSnapshot(payload: unknown, expectedRecordId: string): YjsRecordPresence | null {
    if (!payload || typeof payload !== 'object') return null
    const record = payload as Record<string, unknown>
    const nextRecordId = typeof record.recordId === 'string' ? record.recordId : ''
    if (!nextRecordId || nextRecordId !== expectedRecordId) return null

    const rawUsers = Array.isArray(record.users) ? record.users : []
    const users: YjsPresenceUser[] = rawUsers.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const user = entry as Record<string, unknown>
      const id = typeof user.id === 'string' ? user.id.trim() : ''
      if (!id) return []
      const fieldIds = Array.isArray(user.fieldIds)
        ? user.fieldIds
          .map((fieldId) => (typeof fieldId === 'string' ? fieldId.trim() : ''))
          .filter((fieldId): fieldId is string => fieldId.length > 0)
        : []
      return [{ id, fieldIds: [...new Set(fieldIds)] }]
    })

    return {
      recordId: nextRecordId,
      activeCount: typeof record.activeCount === 'number' && Number.isFinite(record.activeCount)
        ? record.activeCount
        : users.length,
      users,
    }
  }

  async function connect(rid: string) {
    disconnect()
    // Bump generation AFTER disconnect() so any await in a prior
    // connect() sees a different value and bails. Capture locally so
    // we can compare after every await.
    connectGen += 1
    const myGen = connectGen
    currentRecordId = rid
    error.value = null

    // Pass JWT token for server-side verification — not raw userId
    const token = auth.getToken()
    if (!token) {
      error.value = 'Not authenticated'
      return
    }
    const resolvedUserId = await auth.getCurrentUserId().catch(() => null)
    // Stale-guard: if disconnect() or another connect() ran during the
    // getCurrentUserId() await, do NOT proceed to open a socket. The
    // newer call is already in charge of wiring up the next doc.
    if (myGen !== connectGen) return
    currentUserId.value = resolvedUserId

    const yDoc = new Y.Doc()
    doc.value = yDoc

    socket = socketIO('/yjs', {
      transports: ['websocket'],
      auth: { token },
    })

    socket.on('connect', () => {
      connected.value = true
      socket!.emit('yjs:subscribe', { recordId: rid })
    })

    socket.on(
      'yjs:message',
      ({ recordId: rid2, data }: { recordId: string; data: number[] }) => {
        if (rid2 !== currentRecordId) return
        const message = new Uint8Array(data)
        handleSyncMessage(yDoc, socket!, rid2, message)
        synced.value = true
      },
    )

    socket.on(
      'yjs:update',
      ({ recordId: rid2, data }: { recordId: string; data: number[] }) => {
        if (rid2 !== currentRecordId) return
        Y.applyUpdate(yDoc, new Uint8Array(data), 'remote')
      },
    )

    socket.on('yjs:presence', (payload: unknown) => {
      const nextPresence = normalizePresenceSnapshot(payload, rid)
      if (nextPresence) {
        presence.value = nextPresence
      }
    })

    // Send local updates to server
    yDoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote' && socket?.connected) {
        socket.emit('yjs:update', {
          recordId: rid,
          data: Array.from(update),
        })
      }
    })

    socket.on('yjs:error', ({ code, message: msg }: { recordId: string; code: string; message: string }) => {
      error.value = `${code}: ${msg}`
    })

    socket.on('yjs:invalidated', ({ recordId: rid2 }: { recordId: string; reason?: string }) => {
      if (rid2 !== currentRecordId) return
      error.value = 'INVALIDATED: document invalidated by REST write'
      disconnect()
    })

    socket.on('disconnect', () => {
      connected.value = false
      synced.value = false
      presence.value = null
    })
  }

  function setActiveField(fieldId: string | null): void {
    if (!socket || !currentRecordId) return
    socket.emit('yjs:presence', {
      recordId: currentRecordId,
      fieldId: fieldId?.trim() ? fieldId.trim() : null,
    })
  }

  const activeUsers = computed(() => presence.value?.users ?? [])

  const activeCollaborators = computed(() => {
    const selfId = currentUserId.value
    return activeUsers.value.filter((user) => user.id !== selfId)
  })

  const activeCollaboratorCount = computed(() => activeCollaborators.value.length)

  function getFieldCollaborators(fieldId: string): YjsPresenceUser[] {
    const normalizedFieldId = fieldId.trim()
    if (!normalizedFieldId) return []
    const selfId = currentUserId.value
    return activeUsers.value.filter((user) => (
      user.id !== selfId
      && user.fieldIds.includes(normalizedFieldId)
    ))
  }

  function disconnect() {
    // Bump generation so any in-flight connect() await aborts before it
    // creates a socket/doc that nobody is going to watch.
    connectGen += 1
    if (socket) {
      if (currentRecordId) {
        socket.emit('yjs:unsubscribe', { recordId: currentRecordId })
      }
      socket.disconnect()
      socket = null
    }
    if (doc.value) {
      doc.value.destroy()
      doc.value = null
    }
    currentRecordId = null
    connected.value = false
    synced.value = false
    presence.value = null
  }

  // Auto-connect when recordId changes
  const stopRecordWatch = watch(
    recordId,
    (newId) => {
      if (newId) connect(newId)
      else disconnect()
    },
    { immediate: true },
  )

  function dispose(): void {
    try { stopRecordWatch() } catch { /* ignore */ }
    disconnect()
  }

  if (options.registerUnmount !== false) {
    onUnmounted(dispose)
  }

  return {
    doc,
    connected,
    synced,
    error,
    presence,
    activeUsers,
    activeCollaborators,
    activeCollaboratorCount,
    connect,
    disconnect,
    dispose,
    setActiveField,
    getFieldCollaborators,
  }
}
