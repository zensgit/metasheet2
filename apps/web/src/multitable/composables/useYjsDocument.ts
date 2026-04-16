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
 * POC scope: single record, single text field, character-level merge,
 * disconnect/reconnect recovery.
 */
export function useYjsDocument(recordId: Ref<string | null>) {
  const doc = shallowRef<Y.Doc | null>(null)
  const connected = ref(false)
  const synced = ref(false)
  const error = ref<string | null>(null)
  const presence = ref<YjsRecordPresence | null>(null)
  const currentUserId = ref<string | null>(null)

  const auth = useAuth()
  let socket: Socket | null = null
  let currentRecordId: string | null = null

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
    currentRecordId = rid
    error.value = null

    // Pass JWT token for server-side verification — not raw userId
    const token = auth.getToken()
    if (!token) {
      error.value = 'Not authenticated'
      return
    }
    currentUserId.value = await auth.getCurrentUserId().catch(() => null)

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
  watch(
    recordId,
    (newId) => {
      if (newId) connect(newId)
      else disconnect()
    },
    { immediate: true },
  )

  onUnmounted(disconnect)

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
    setActiveField,
    getFieldCollaborators,
  }
}
