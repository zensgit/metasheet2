import { computed, ref, shallowRef, onUnmounted, watch } from 'vue'
import type { Ref } from 'vue'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { io as socketIO, type Socket } from 'socket.io-client'
import { useAuth } from '../../composables/useAuth'
import { useLocale } from '../../composables/useLocale'
import { metaCoreLabel } from '../utils/meta-core-labels'
import {
  SESSION_ENDED_EVENT,
  classifyConnectError,
  classifyDisconnect,
  createReconnectBackoff,
  readRefusalNotice,
  type RealtimeRefusalNotice,
} from '../../utils/realtimeReconnect'
import type { YjsRecordPresence, YjsPresenceUser } from '../types'

const MSG_SYNC = 0

/** How many times in a row a record is reopened after a transient refusal before giving up. */
const MAX_REOPEN_ATTEMPTS = 6

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
    syncProtocol.readSyncMessage(decoder, encoder, doc, 'remote')

    const reply = encoding.toUint8Array(encoder)
    if (reply.length > 1) {
      socket.emit('yjs:message', { recordId, data: Array.from(reply) })
    }
  }
}

function sendSyncStep1(doc: Y.Doc, socket: Socket, recordId: string): void {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  socket.emit('yjs:message', {
    recordId,
    data: Array.from(encoding.toUint8Array(encoder)),
  })
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
  const { isZh } = useLocale()
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
  /**
   * After a refusal the server marked as transient the record is reopened from scratch (new
   * connection, new document) with capped backoff. A caller that falls back on a disconnect
   * cancels this by calling disconnect(), exactly as before.
   */
  const reopenBackoff = createReconnectBackoff()
  let reopenTimer: ReturnType<typeof setTimeout> | null = null

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

  function cancelReopen(): void {
    if (reopenTimer) clearTimeout(reopenTimer)
    reopenTimer = null
    reopenBackoff.reset()
  }

  function scheduleReopen(rid: string): void {
    if (reopenTimer || currentRecordId !== rid) return
    teardown()
    if (reopenBackoff.attempts >= MAX_REOPEN_ATTEMPTS) {
      reopenBackoff.reset()
      error.value = 'UNAVAILABLE: realtime unavailable'
      return
    }
    reopenTimer = setTimeout(() => {
      reopenTimer = null
      if (currentRecordId !== rid) return
      void open(rid)
    }, reopenBackoff.next())
  }

  async function connect(rid: string) {
    cancelReopen()
    await open(rid)
  }

  async function open(rid: string) {
    teardown()
    // Bump generation AFTER teardown() so any await in a prior
    // connect() sees a different value and bails. Capture locally so
    // we can compare after every await.
    connectGen += 1
    const myGen = connectGen
    currentRecordId = rid
    error.value = null

    // Pass JWT token for server-side verification — not raw userId
    const token = auth.getToken()
    if (!token) {
      error.value = metaCoreLabel('auth.notAuthenticated', isZh.value)
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
    let requestedServerState = false

    socket = socketIO('/yjs', {
      transports: ['websocket'],
      auth: { token },
    })

    let lastNotice: RealtimeRefusalNotice | null = null
    socket.on(SESSION_ENDED_EVENT, (payload: unknown) => {
      lastNotice = readRefusalNotice(payload)
    })
    socket.on('connect_error', (connectError: unknown) => {
      if (classifyConnectError(connectError, socket?.active) === 'transient') scheduleReopen(rid)
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
        if (!requestedServerState) {
          requestedServerState = true
          sendSyncStep1(yDoc, socket!, rid2)
        }
        synced.value = true
        reopenBackoff.reset()
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

    socket.on('yjs:invalidated', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const rid2 = (payload as { recordId?: unknown }).recordId
      if (typeof rid2 !== 'string') return
      if (rid2 !== currentRecordId) return
      error.value = 'INVALIDATED: document invalidated by REST write'
      disconnect()
    })

    socket.on('disconnect', (reason: unknown) => {
      connected.value = false
      synced.value = false
      presence.value = null
      const notice = lastNotice
      lastNotice = null
      if (classifyDisconnect(reason, notice) === 'transient') scheduleReopen(rid)
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

  /** Closes the connection and drops the document; the record that is open stays the same. */
  function teardown() {
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
    connected.value = false
    synced.value = false
    presence.value = null
  }

  function disconnect() {
    cancelReopen()
    teardown()
    currentRecordId = null
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
